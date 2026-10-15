// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type {
  JsonRpcConnection,
  JsonRpcProvider,
  JsonRpcRequest as UpstreamJsonRpcRequest,
} from '@polkadot-api/json-rpc-provider';
import { reportListener } from '@dotli/metrics';
import { log } from '@dotli/shared';
import { chainHaltedError } from './chain-halted.js';
import { createFollowSnapshot, type FollowSnapshot } from './follow-snapshot.js';
import { isRecord, stringsOf } from './json-shape.js';
import { TERMINAL_WATCH_EVENTS } from './watch-guard.js';

/** `connectRemote`'s connection, typed as strings to match the postMessage wire. */
export interface StringJsonRpcConnection {
  send: (message: string) => void;
  disconnect: () => void;
}

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: unknown;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: JsonRpcId;
  result?: unknown;
  error?: unknown;
}

interface SubscriptionMessage {
  jsonrpc?: string;
  method?: unknown;
  params?: {
    subscription?: unknown;
    result?: unknown;
  };
}

/**
 * Who the answer to an upstream request goes to. Each request the broker sends upstream with an id has exactly one
 * owner (a session, a shared follow, a session that left or a release the broker sent itself), so an answer is never
 * routed by guessing what its id holds.
 */
type RequestOwner =
  /** A session's own request, answered under the session's id for it. */
  | { kind: 'session'; sessionId: string; clientId: JsonRpcId; method: string }
  /** The upstream follow a shared follow waits on, answered to every session waiting on it. */
  | { kind: 'follow'; follow: SharedFollow }
  /** A request whose session left before the answer. A subscription the answer opens is released at once. */
  | { kind: 'orphan'; method: string }
  /** A release the broker sent itself. Nobody waits on its answer. */
  | { kind: 'release'; method: string };

function methodOf(owner: RequestOwner): string {
  return owner.kind === 'follow' ? 'chainHead_v1_follow' : owner.method;
}

function previewResponse(response: JsonRpcResponse): string {
  if ('error' in response) {
    return `error=${JSON.stringify(response.error)}`;
  }
  if (typeof response.result === 'string' && response.result.length > 200) {
    return `result=${response.result.slice(0, 200)}... (${String(response.result.length)} chars)`;
  }
  return `result=${JSON.stringify(response.result)}`;
}

interface OwnedToken {
  sessionId: string;
  localToken: string;
  upstreamToken: string;
  releaseMethod: string;
}

interface SharedFollow {
  key: string;
  upstreamToken: string | null;
  localTokens: Set<string>;
  pendingLocals: {
    sessionId: string;
    requestId: JsonRpcId;
    localToken: string;
  }[];
  /** What the follow told its sessions so far, and who still pins each of its blocks. */
  snapshot: FollowSnapshot;
}

type WireMode = 'string' | 'object';

// Fixed per session, never sniffed from message shape, so one malformed payload cannot flip the
// encoding of every later message. "string" because first-party consumers send JSON strings.
const DEFAULT_WIRE_MODE: WireMode = 'string';

interface Session {
  id: string;
  onMessage: (message: unknown) => void;
  ownedTokens: Set<string>;
  connected: boolean;
  wireMode: WireMode;
  /** Told once when the chain's transport halts for good. */
  onHalt: ((error?: unknown) => void) | null;
}

interface BrokerConnection {
  send: (message: unknown) => void;
  disconnect: () => void;
}

const TOKEN_METHODS = new Map<string, string>([
  ['transaction_v1_broadcast', 'transaction_v1_stop'],
  ['transactionWatch_v1_submitAndWatch', 'transactionWatch_v1_unwatch'],
  ['statement_subscribeStatement', 'statement_unsubscribeStatement'],
]);
const RELEASE_METHODS = new Set<string>(TOKEN_METHODS.values());
const MAX_EARLY_SUBSCRIPTION_TOKENS = 32;
const MAX_EARLY_SUBSCRIPTION_EVENTS_PER_TOKEN = 16;

function buildJsonRpcError(
  id: JsonRpcId,
  error: string | ReturnType<typeof chainHaltedError>,
): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: typeof error === 'string' ? { code: -32603, message: error } : error };
}

function buildJsonRpcResult(id: JsonRpcId, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function isRequestMessage(value: unknown): value is JsonRpcRequest {
  return isRecord(value) && typeof value['method'] === 'string';
}

function isResponseMessage(value: unknown): value is JsonRpcResponse {
  return isRecord(value) && 'id' in value && !('method' in value);
}

function isSubscriptionMessage(value: unknown): value is SubscriptionMessage {
  return isRecord(value) && 'method' in value && isRecord(value['params']) && 'subscription' in value['params'];
}

/** Parses strings on the object wire too, since some substrate clients serialize inconsistently. */
function parseInbound(message: unknown): unknown {
  if (typeof message === 'string') {
    return JSON.parse(message);
  }
  return message;
}

function encode(value: unknown, mode: WireMode): unknown {
  return mode === 'string' ? JSON.stringify(value) : value;
}

/** `chainHead_v1_unpin` takes its hash arg as a string or an array. */
function normalizeUnpinHashes(param: unknown): string[] {
  return typeof param === 'string' ? [param] : stringsOf(param);
}

function cloneWithRewrittenFirstParam(request: JsonRpcRequest, rewrittenToken: string): JsonRpcRequest {
  const params: unknown[] = Array.isArray(request.params) ? [...(request.params as unknown[])] : [];
  params[0] = rewrittenToken;
  return { ...request, params };
}

function releaseResultFor(method: string): unknown {
  return method === 'statement_unsubscribeStatement' ? true : null;
}

/** Whether `event` ends its subscription on the node's side, so nothing is sent upstream to end it again. */
function endsSubscription(method: unknown, event: unknown): boolean {
  if (event === 'stop') {
    return true;
  }
  return method === 'transactionWatch_v1_watchEvent' && typeof event === 'string' && TERMINAL_WATCH_EVENTS.has(event);
}

export interface ChainBrokerManager {
  connectRemote(
    genesisHash: string,
    connectionId: string,
    onMessage: (message: string) => void,
  ): StringJsonRpcConnection | null;
  /** `holder` names the lease in debug logs. */
  getLocalProvider(genesisHash: string, holder?: string): JsonRpcProvider | null;
  disconnectAll(): void;
}

// Routes the resolver's Asset Hub reads through the broker's shared follow. The object wire matches
// the getSmProvider boundary the resolver expects.
export function requireBrokerLocalProvider(
  manager: ChainBrokerManager,
  genesisHash: string,
  label: string,
): JsonRpcProvider {
  const provider = manager.getLocalProvider(genesisHash, 'resolver');
  if (provider === null) {
    throw new Error(`No broker provider available for ${label}`);
  }
  return provider;
}

// Debug level, so per-message traffic prints only with VITE_APP_DEBUG.
const BROKER_TAG = '[dot.li broker]';
function brokerLog(...args: unknown[]): void {
  log.debug(BROKER_TAG, ...args);
}
// Anomalies warn so they reach Sentry breadcrumbs in every build. A broken chain repeats one on every
// message and would flood the trail, so each kind logs its first few, then a count at each power of ten.
const WARN_IN_FULL = 3;

/** Logs one anomaly of `kind`, or only counts it once that kind has logged its first few. */
export type BrokerWarner = (kind: string, message: string) => void;

/** Warns of one chain's anomalies, counted per kind so one broken chain cannot mute another's. */
export function createBrokerWarner(): BrokerWarner {
  const counts = new Map<string, number>();
  return (kind, message) => {
    const count = (counts.get(kind) ?? 0) + 1;
    counts.set(kind, count);
    if (count <= WARN_IN_FULL) {
      log.warn(`${BROKER_TAG} ${message}`);
    } else if (/^10+$/.test(String(count))) {
      log.warn(`${BROKER_TAG} ${kind}: ${String(count)} so far`);
    }
  };
}

// A session's handler that throws on the halt is a defect in its owner, reported while the other sessions still hear it.
const reportHaltListener = reportListener('protocol', 'chain_halt');

export class ChainBroker {
  private readonly provider: JsonRpcProvider;
  private readonly warn: BrokerWarner;
  private upstream: JsonRpcConnection | null = null;
  private readonly sessions = new Map<string, Session>();
  private readonly pending = new Map<string, RequestOwner>();
  private readonly localToOwned = new Map<string, OwnedToken>();
  private readonly upstreamToOwned = new Map<string, Set<string>>();
  private readonly earlySubscriptions = new Map<string, SubscriptionMessage[]>();
  private readonly localFollowTokens = new Map<string, { sessionId: string; followKey: string }>();
  private readonly sharedFollows = new Map<string, SharedFollow>();
  private readonly upstreamFollowTokens = new Map<string, SharedFollow>();
  private requestCounter = 0;
  private tokenCounter = 0;

  /** `warn` is passed by an owner that rebuilds brokers for one chain, so a rebuild keeps that chain's count. */
  constructor(provider: JsonRpcProvider, warn: BrokerWarner = createBrokerWarner()) {
    this.provider = provider;
    this.warn = warn;
  }

  private sendToSession(session: Session, obj: unknown): void {
    session.onMessage(encode(obj, session.wireMode));
  }

  private sendUpstream(obj: unknown): void {
    this.upstream?.send(obj as UpstreamJsonRpcRequest);
  }

  /** Sends `request` upstream under a fresh broker id, owned by `owner` until its answer arrives. */
  private sendTracked(owner: RequestOwner, request: JsonRpcRequest): void {
    const upstreamId = `broker:${this.requestCounter.toString(36)}`;
    this.requestCounter += 1;
    this.pending.set(upstreamId, owner);
    this.sendUpstream({ ...request, id: upstreamId });
  }

  /** Forwards a session's request, owned by the session when it expects an answer. */
  private forwardForSession(session: Session, request: JsonRpcRequest, method: string): void {
    if (request.id === undefined) {
      this.sendUpstream(request);
      return;
    }
    this.sendTracked({ kind: 'session', sessionId: session.id, clientId: request.id, method }, request);
  }

  /** A release the broker sends itself, for something no session holds anymore. */
  private sendRelease(method: string, params: unknown[]): void {
    this.sendTracked({ kind: 'release', method }, { jsonrpc: '2.0', method, params });
  }

  connect(
    sessionId: string,
    onMessage: (message: unknown) => void,
    wireMode: WireMode = DEFAULT_WIRE_MODE,
    onHalt: ((error?: unknown) => void) | null = null,
  ): BrokerConnection {
    if (this.sessions.has(sessionId)) {
      throw new Error(`Duplicate broker session: ${sessionId}`);
    }

    brokerLog(`Session ${sessionId} connecting (${String(this.sessions.size)} existing sessions)`);
    this.ensureUpstream();
    this.sessions.set(sessionId, {
      id: sessionId,
      onMessage,
      ownedTokens: new Set<string>(),
      connected: true,
      wireMode,
      onHalt,
    });

    return {
      send: message => {
        this.sendFromSession(sessionId, message);
      },
      disconnect: () => {
        this.disconnectSession(sessionId);
      },
    };
  }

  disconnectAll(): void {
    for (const sessionId of [...this.sessions.keys()]) {
      this.disconnectSession(sessionId);
    }
    this.disconnectUpstream();
  }

  /**
   * The transport is gone for good. Each session first gets an error per request in flight and a
   * `stop` per established follow (transaction watches already got `dropped` from the watch guard).
   * The upstream is dropped without unsubscribing, as nothing is left to unsubscribe from.
   */
  halt(error?: unknown): void {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    for (const session of sessions) {
      // A throwing message handler must not keep its session from hearing the halt.
      try {
        this.answerHaltedSession(session);
      } catch (thrown) {
        reportHaltListener(thrown);
      }
      session.connected = false;
      // One session's handler must not keep the others from hearing the halt.
      try {
        session.onHalt?.(error);
      } catch (thrown) {
        reportHaltListener(thrown);
      }
    }
    this.disconnectUpstream();
  }

  private answerHaltedSession(session: Session): void {
    for (const owner of this.pending.values()) {
      if (owner.kind === 'session' && owner.sessionId === session.id && owner.clientId !== null) {
        this.sendToSession(session, buildJsonRpcError(owner.clientId, chainHaltedError()));
      }
    }
    for (const sharedFollow of this.sharedFollows.values()) {
      for (const pendingLocal of sharedFollow.pendingLocals) {
        if (pendingLocal.sessionId === session.id && pendingLocal.requestId !== null) {
          this.sendToSession(session, buildJsonRpcError(pendingLocal.requestId, chainHaltedError()));
        }
      }
    }
    for (const [localToken, followToken] of this.localFollowTokens) {
      if (followToken.sessionId !== session.id) {
        continue;
      }
      if ((this.sharedFollows.get(followToken.followKey)?.upstreamToken ?? null) === null) {
        continue;
      }
      this.sendToSession(session, {
        jsonrpc: '2.0',
        method: 'chainHead_v1_followEvent',
        params: { subscription: localToken, result: { event: 'stop' } },
      });
    }
  }

  private ensureUpstream(): void {
    if (this.upstream !== null) {
      return;
    }
    brokerLog(`Connecting to upstream provider... (sessions: [${[...this.sessions.keys()].join(',')}])`);
    this.upstream = this.provider(message => {
      this.handleUpstreamMessage(message);
    });
    brokerLog(
      `Upstream provider connected (send=${typeof this.upstream.send}, disconnect=${typeof this.upstream.disconnect})`,
    );
  }

  private sendFromSession(sessionId: string, message: unknown): void {
    const session = this.sessions.get(sessionId);
    if (session?.connected !== true) {
      this.warn('session_not_connected', `sendFromSession: session ${sessionId} not connected, dropping message`);
      return;
    }

    let parsed: unknown;
    try {
      parsed = parseInbound(message);
    } catch {
      this.warn('session_invalid_json', `sendFromSession: invalid JSON from session ${sessionId}`);
      this.sendToSession(session, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32603, message: 'Invalid JSON-RPC payload' },
      });
      return;
    }

    if (Array.isArray(parsed)) {
      this.sendToSession(session, buildJsonRpcError(null, 'Batch JSON-RPC is unsupported'));
      return;
    }

    if (!isRequestMessage(parsed)) {
      this.warn('session_not_request', `sendFromSession: not a request from session ${sessionId}`);
      this.sendToSession(session, buildJsonRpcError(null, 'Invalid JSON-RPC request'));
      return;
    }

    brokerLog(`→ upstream [${sessionId}] method=${parsed.method as string} id=${String(parsed.id)}`);

    if ((parsed.method as string) === 'chainHead_v1_follow') {
      this.handleLocalFollowRequest(session, parsed);
      return;
    }

    if ((parsed.method as string) === 'chainHead_v1_unfollow') {
      this.handleLocalUnfollowRequest(session, parsed);
      return;
    }

    if ((parsed.method as string) === 'chainHead_v1_unpin') {
      this.handleLocalUnpinRequest(session, parsed);
      return;
    }

    this.routeGenericRequest(session, parsed);
  }

  /** Rewrite a session-owned token to its upstream token and forward. */
  private routeGenericRequest(session: Session, request: JsonRpcRequest): void {
    const method = request.method as string;
    if (RELEASE_METHODS.has(method)) {
      this.routeOwnedReleaseRequest(session, request, method);
      return;
    }

    const rewritten = this.rewriteOwnedToken(session, request);
    if (rewritten === null) {
      this.warn(
        'request_unknown_token',
        `routeGenericRequest: unknown token for session ${session.id}, method=${method}`,
      );
      this.sendToSession(session, buildJsonRpcError(request.id ?? null, 'Unknown subscription/token'));
      return;
    }

    this.forwardForSession(session, rewritten, method);
  }

  private routeOwnedReleaseRequest(session: Session, request: JsonRpcRequest, method: string): void {
    const params = Array.isArray(request.params) ? request.params : [];
    const localToken = typeof params[0] === 'string' ? params[0] : null;
    const owned = localToken !== null ? this.localToOwned.get(localToken) : undefined;
    if (localToken === null || owned?.sessionId !== session.id || owned.releaseMethod !== method) {
      this.sendToSession(session, buildJsonRpcError(request.id ?? null, 'Unknown subscription/token'));
      return;
    }

    const upstreamToken = owned.upstreamToken;
    const released = this.releaseOwnedToken(localToken, false);
    if (released === null) {
      this.sendToSession(session, buildJsonRpcError(request.id ?? null, 'Unknown subscription/token'));
      return;
    }

    if (!released.lastOwner) {
      if (request.id !== undefined) {
        this.sendToSession(session, buildJsonRpcResult(request.id ?? null, releaseResultFor(method)));
      }
      return;
    }

    this.forwardForSession(session, cloneWithRewrittenFirstParam(request, upstreamToken), method);
  }

  /** Ref-counted unpin, forwarded only once no session holds the block. Replies success locally at once. */
  private handleLocalUnpinRequest(session: Session, request: JsonRpcRequest): void {
    const params = Array.isArray(request.params) ? request.params : [];
    const token = typeof params[0] === 'string' ? params[0] : null;
    const followToken = token !== null ? this.localFollowTokens.get(token) : undefined;

    // Not this session's follow token, so it passes through unchanged.
    if (!followToken || token === null || followToken.sessionId !== session.id) {
      this.routeGenericRequest(session, request);
      return;
    }

    const sharedFollow = this.sharedFollows.get(followToken.followKey);
    if (sharedFollow?.upstreamToken === undefined || sharedFollow.upstreamToken === null) {
      this.sendToSession(session, buildJsonRpcError(request.id ?? null, 'Unknown subscription/token'));
      return;
    }

    const orphaned = sharedFollow.snapshot.release(token, normalizeUnpinHashes(params[1]));
    if (orphaned.length > 0) {
      this.sendRelease('chainHead_v1_unpin', [sharedFollow.upstreamToken, orphaned]);
    }

    if (request.id !== undefined) {
      this.sendToSession(session, buildJsonRpcResult(request.id ?? null, null));
    }
  }

  private rewriteOwnedToken(session: Session, request: JsonRpcRequest): JsonRpcRequest | null {
    if (!Array.isArray(request.params) || request.params.length === 0) {
      return request;
    }

    const firstParam: unknown = request.params[0];
    if (typeof firstParam !== 'string') {
      return request;
    }

    const followToken = this.localFollowTokens.get(firstParam);
    if (followToken) {
      if (followToken.sessionId !== session.id) {
        return null;
      }
      const sharedFollow = this.sharedFollows.get(followToken.followKey);
      if (sharedFollow?.upstreamToken === undefined || sharedFollow.upstreamToken === null) {
        return null;
      }
      return cloneWithRewrittenFirstParam(request, sharedFollow.upstreamToken);
    }

    const owned = this.localToOwned.get(firstParam);
    if (!owned) {
      return request;
    }

    if (owned.sessionId !== session.id) {
      return null;
    }

    return cloneWithRewrittenFirstParam(request, owned.upstreamToken);
  }

  private handleUpstreamMessage(message: unknown): void {
    // Strings too, since some test harnesses feed serialized JSON.
    let parsed: unknown;
    try {
      parsed = parseInbound(message);
    } catch (err: unknown) {
      // Recover the id from the raw text so its pending request is rejected instead of waiting forever.
      const reason = err instanceof Error ? err.message : String(err);
      const size = typeof message === 'string' ? message.length : JSON.stringify(message).length;
      this.warn('upstream_unparseable', `← upstream: unparseable message of ${String(size)} chars (${reason})`);
      if (typeof message === 'string') {
        const matchedId = /"id"\s*:\s*("?)([^",}\s]+)\1/.exec(message)?.[2];
        if (matchedId !== undefined && this.pending.has(matchedId)) {
          this.handleUpstreamResponse({
            jsonrpc: '2.0',
            id: matchedId,
            error: { code: -32603, message: `Upstream returned unparseable response: ${reason}` },
          });
        }
      }
      return;
    }

    if (Array.isArray(parsed)) {
      this.warn('upstream_batch', `← upstream: unexpected batch message, ignoring`);
      return;
    }

    if (isSubscriptionMessage(parsed)) {
      const result = parsed.params?.result;
      if (isRecord(result)) {
        const event = result['event'];
        const rawSub = parsed.params?.subscription;
        const token = typeof rawSub === 'string' ? rawSub : '?';
        const ownedLocals = this.upstreamToOwned.get(token);
        const sessionTag =
          ownedLocals !== undefined && ownedLocals.size > 0
            ? [...ownedLocals].map(localToken => this.localToOwned.get(localToken)?.sessionId ?? '?').join(',')
            : 'unknown';
        if (event === 'newBlock') {
          brokerLog(
            `← raw newBlock [${sessionTag}] hash=${String(result['blockHash']).slice(0, 18)}… parent=${String(result['parentBlockHash']).slice(0, 18)}… token=${token.slice(0, 12)}…`,
          );
        } else if (event === 'initialized') {
          const hashes = result['finalizedBlockHashes'];
          const hashList = Array.isArray(hashes) ? (hashes as string[]).map(h => h.slice(0, 18) + '…').join(', ') : '?';
          brokerLog(`← raw initialized [${sessionTag}] blocks=[${hashList}] token=${token.slice(0, 12)}…`);
        }
      }
      this.handleUpstreamSubscription(parsed);
      return;
    }

    if (isResponseMessage(parsed)) {
      this.handleUpstreamResponse(parsed);
      return;
    }

    this.warn('upstream_unrecognized', `← upstream: unrecognized message type`);
  }

  private handleUpstreamResponse(response: JsonRpcResponse): void {
    const id = String(response.id);
    const owner = this.pending.get(id);
    if (owner === undefined) {
      this.warn('response_unknown_id', `← upstream response for unknown id=${id}`);
      return;
    }
    this.pending.delete(id);
    brokerLog(
      `Upstream answer for ${owner.kind === 'session' ? owner.sessionId : owner.kind}, method=${methodOf(owner)} ${previewResponse(response)}`,
    );
    if (owner.kind === 'follow') {
      this.answerFollow(owner.follow, response);
    } else if (owner.kind === 'orphan') {
      this.answerOrphan(owner.method, response);
    } else if (owner.kind === 'release') {
      this.answerRelease(owner.method, response);
    } else {
      this.answerSession(owner, response);
    }
  }

  private answerSession(owner: Extract<RequestOwner, { kind: 'session' }>, response: JsonRpcResponse): void {
    const session = this.sessions.get(owner.sessionId);
    if (session?.connected !== true) {
      this.warn(
        'response_disconnected_session',
        `upstream response for disconnected session: sessionId=${JSON.stringify(owner.sessionId)}, method=${owner.method}, responseId=${String(response.id)}`,
      );
      return;
    }
    const releaseMethod = TOKEN_METHODS.get(owner.method);
    const upstreamToken = releaseMethod !== undefined && typeof response.result === 'string' ? response.result : null;
    const rewritten: Record<string, unknown> = { ...response, id: owner.clientId };
    if (upstreamToken !== null && releaseMethod !== undefined) {
      rewritten['result'] = this.mapOwnedToken(session, upstreamToken, releaseMethod, owner.method);
    }
    this.sendToSession(session, rewritten);
    if (upstreamToken !== null) {
      this.flushEarlySubscriptions(upstreamToken);
    }
  }

  /** Maps an upstream subscription to a new local token `session` owns, and returns that token. */
  private mapOwnedToken(session: Session, upstreamToken: string, releaseMethod: string, method: string): string {
    const localToken = `token:${this.tokenCounter.toString(36)}:${session.id}`;
    this.tokenCounter += 1;
    this.localToOwned.set(localToken, { sessionId: session.id, localToken, upstreamToken, releaseMethod });
    let localTokens = this.upstreamToOwned.get(upstreamToken);
    if (localTokens === undefined) {
      localTokens = new Set<string>();
      this.upstreamToOwned.set(upstreamToken, localTokens);
    }
    localTokens.add(localToken);
    session.ownedTokens.add(localToken);
    brokerLog(`Token mapped: ${localToken} to ${upstreamToken} (${method})`);
    return localToken;
  }

  /** The upstream's answer to a shared follow, told to every session waiting on it. */
  private answerFollow(follow: SharedFollow, response: JsonRpcResponse): void {
    if (typeof response.result !== 'string') {
      this.failFollow(follow, response);
      return;
    }
    const upstreamToken = response.result;
    // Every session left while the follow was in flight, and nobody else would ever end it.
    if (follow.localTokens.size === 0) {
      this.dropSharedFollow(follow);
      this.earlySubscriptions.delete(upstreamToken);
      this.sendRelease('chainHead_v1_unfollow', [upstreamToken]);
      return;
    }
    follow.upstreamToken = upstreamToken;
    this.upstreamFollowTokens.set(upstreamToken, follow);
    for (const pendingLocal of follow.pendingLocals.splice(0)) {
      const pendingSession = this.sessions.get(pendingLocal.sessionId);
      if (pendingSession?.connected !== true) {
        continue;
      }
      this.sendToSession(pendingSession, buildJsonRpcResult(pendingLocal.requestId, pendingLocal.localToken));
    }
    this.flushEarlySubscriptions(upstreamToken);
  }

  /**
   * The upstream refused the follow. It is dropped before any session hears the refusal, so a session that follows
   * again from inside its delivery, as papi does, asks the upstream afresh instead of waiting on the refused one.
   */
  private failFollow(follow: SharedFollow, response: JsonRpcResponse): void {
    this.dropSharedFollow(follow);
    const error =
      'error' in response ? response.error : { code: -32603, message: 'Invalid chainHead_v1_follow answer' };
    for (const localToken of follow.localTokens) {
      const followToken = this.localFollowTokens.get(localToken);
      this.localFollowTokens.delete(localToken);
      if (followToken !== undefined) {
        this.sessions.get(followToken.sessionId)?.ownedTokens.delete(localToken);
      }
    }
    follow.localTokens.clear();
    for (const pendingLocal of follow.pendingLocals.splice(0)) {
      const session = this.sessions.get(pendingLocal.sessionId);
      if (session?.connected === true && pendingLocal.requestId !== null) {
        this.sendToSession(session, { jsonrpc: '2.0', id: pendingLocal.requestId, error });
      }
    }
  }

  /**
   * The answer to a request whose session left while it was in flight. A subscription it opened would run upstream
   * for the broker's life, so it is released at once, unless a session still holds the same upstream subscription.
   */
  private answerOrphan(method: string, response: JsonRpcResponse): void {
    const releaseMethod = TOKEN_METHODS.get(method);
    if (releaseMethod === undefined || typeof response.result !== 'string') {
      brokerLog(`Dropped the answer to ${method} for a session that left`);
      return;
    }
    const upstreamToken = response.result;
    if ((this.upstreamToOwned.get(upstreamToken)?.size ?? 0) > 0) {
      return;
    }
    this.earlySubscriptions.delete(upstreamToken);
    this.sendRelease(releaseMethod, [upstreamToken]);
  }

  /** Nobody waits on a release, so the node refusing one is all there is to tell. */
  private answerRelease(method: string, response: JsonRpcResponse): void {
    if ('error' in response) {
      this.warn('release_refused', `upstream refused ${method}: ${JSON.stringify(response.error)}`);
    }
  }

  /**
   * Forgets `follow` and its upstream token, unless a newer follow on the same key replaced it already. The token
   * and its reverse map entry are cleared together.
   */
  private dropSharedFollow(follow: SharedFollow): void {
    if (this.sharedFollows.get(follow.key) === follow) {
      this.sharedFollows.delete(follow.key);
    }
    if (follow.upstreamToken !== null) {
      if (this.upstreamFollowTokens.get(follow.upstreamToken) === follow) {
        this.upstreamFollowTokens.delete(follow.upstreamToken);
      }
      follow.upstreamToken = null;
    }
  }

  private handleUpstreamSubscription(message: SubscriptionMessage): void {
    const upstreamToken = message.params?.subscription;
    if (typeof upstreamToken !== 'string') {
      this.warn('subscription_bad_token', `← upstream subscription with non-string token`);
      return;
    }

    const sharedFollow = this.upstreamFollowTokens.get(upstreamToken);
    if (sharedFollow) {
      const eventResult = message.params?.result;
      if (isRecord(eventResult) && eventResult['event'] === 'stop') {
        this.stopSharedFollow(sharedFollow, upstreamToken, message);
        return;
      }
      const orphaned = sharedFollow.snapshot.record(eventResult);
      if (orphaned.length > 0) {
        this.sendRelease('chainHead_v1_unpin', [upstreamToken, orphaned]);
      }
      // Every session holds the event's blocks before any hears it. A session that unpins inside its own delivery, as
      // polkadot-api does on `initialized`, would otherwise release them upstream under a session not yet told.
      const recipients: { session: Session; localToken: string }[] = [];
      for (const localToken of sharedFollow.localTokens) {
        const session = this.sessions.get(this.localFollowTokens.get(localToken)?.sessionId ?? '');
        if (session?.connected === true) {
          sharedFollow.snapshot.pinEvent(localToken, eventResult);
          recipients.push({ session, localToken });
        }
      }
      const eventType = isRecord(eventResult)
        ? typeof eventResult['event'] === 'string'
          ? eventResult['event']
          : 'unknown'
        : '?';
      for (const { session, localToken } of recipients) {
        // An earlier delivery can end this follow or session.
        if (!session.connected || !sharedFollow.localTokens.has(localToken)) {
          continue;
        }
        brokerLog(`← subscription [${session.id}] event=${eventType} method=${String(message.method)}`);
        this.sendToSession(session, {
          ...message,
          params: {
            ...message.params,
            subscription: localToken,
          },
        });
      }
      return;
    }

    const ownedLocals = this.upstreamToOwned.get(upstreamToken);
    if (ownedLocals === undefined || ownedLocals.size === 0) {
      if (this.hasPendingSubscriptionRequest()) {
        this.bufferEarlySubscription(upstreamToken, message);
        return;
      }
      this.warn('subscription_unknown_token', `← upstream subscription for unknown token: ${upstreamToken}`);
      return;
    }

    const eventResult = message.params?.result;
    const eventType = isRecord(eventResult)
      ? typeof eventResult['event'] === 'string'
        ? eventResult['event']
        : 'unknown'
      : '?';
    const localTokens = [...ownedLocals];
    for (const localToken of localTokens) {
      const owned = this.localToOwned.get(localToken);
      if (owned === undefined) {
        continue;
      }

      const session = this.sessions.get(owned.sessionId);
      if (session?.connected !== true) {
        this.warn(
          'subscription_disconnected_session',
          `← upstream subscription for disconnected session: ${owned.sessionId}`,
        );
        continue;
      }

      brokerLog(`← subscription [${owned.sessionId}] event=${eventType} method=${String(message.method)}`);

      this.sendToSession(session, {
        ...message,
        params: {
          ...message.params,
          subscription: owned.localToken,
        },
      });
    }

    if (isRecord(eventResult) && endsSubscription(message.method, eventResult['event'])) {
      brokerLog(`Token ended by upstream: ${upstreamToken}`);
      for (const localToken of localTokens) {
        this.releaseOwnedToken(localToken, false);
      }
    }
  }

  private hasPendingSubscriptionRequest(): boolean {
    return [...this.pending.values()].some(owner => owner.kind === 'follow' || TOKEN_METHODS.has(methodOf(owner)));
  }

  private bufferEarlySubscription(upstreamToken: string, message: SubscriptionMessage): void {
    let events = this.earlySubscriptions.get(upstreamToken);
    if (events === undefined) {
      if (this.earlySubscriptions.size >= MAX_EARLY_SUBSCRIPTION_TOKENS) {
        const oldestToken = this.earlySubscriptions.keys().next().value;
        if (oldestToken !== undefined) {
          this.earlySubscriptions.delete(oldestToken);
          this.warn(
            'early_token_cap',
            `early-subscription token cap hit; dropping buffered events for oldest token: ${oldestToken}`,
          );
        }
      }
      events = [];
      this.earlySubscriptions.set(upstreamToken, events);
    }
    if (events.length < MAX_EARLY_SUBSCRIPTION_EVENTS_PER_TOKEN) {
      events.push(message);
    } else {
      // Bounds memory for a token that never maps to a local subscription.
      this.warn('early_event_cap', `early-subscription event cap hit; dropping event for token: ${upstreamToken}`);
    }
  }

  private flushEarlySubscriptions(upstreamToken: string): void {
    const events = this.earlySubscriptions.get(upstreamToken);
    if (events === undefined) {
      return;
    }
    this.earlySubscriptions.delete(upstreamToken);
    for (const event of events) {
      this.handleUpstreamSubscription(event);
    }
  }

  private disconnectSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    brokerLog(
      `disconnectSession(${sessionId}) called — pending=${String(this.pending.size)}, tokens=${String(session.ownedTokens.size)}`,
    );
    brokerLog(`disconnectSession stack: ${new Error().stack?.split('\n').slice(1, 5).join(' <- ') ?? ''}`);
    session.connected = false;
    this.sessions.delete(sessionId);

    // An answer still on its way may open a subscription, which nobody would release once its session has gone.
    for (const [requestId, owner] of this.pending) {
      if (owner.kind === 'session' && owner.sessionId === sessionId) {
        this.pending.set(requestId, { kind: 'orphan', method: owner.method });
      }
    }

    for (const localToken of [...session.ownedTokens]) {
      this.releaseOwnedToken(localToken, true);
    }

    for (const [localToken, followToken] of [...this.localFollowTokens.entries()]) {
      if (followToken.sessionId === sessionId) {
        this.releaseLocalFollowToken(localToken);
      }
    }
  }

  private releaseOwnedToken(localToken: string, notifyUpstream: boolean): { lastOwner: boolean } | null {
    const owned = this.localToOwned.get(localToken);
    if (!owned) {
      return null;
    }

    this.localToOwned.delete(localToken);
    const session = this.sessions.get(owned.sessionId);
    session?.ownedTokens.delete(localToken);

    const localTokens = this.upstreamToOwned.get(owned.upstreamToken);
    if (localTokens?.delete(localToken) !== true) {
      return null;
    }

    if (localTokens.size > 0) {
      return { lastOwner: false };
    }

    this.upstreamToOwned.delete(owned.upstreamToken);
    if (notifyUpstream) {
      this.sendRelease(owned.releaseMethod, [owned.upstreamToken]);
    }
    return { lastOwner: true };
  }

  private disconnectUpstream(): void {
    this.pending.clear();
    this.localToOwned.clear();
    this.upstreamToOwned.clear();
    this.earlySubscriptions.clear();
    this.localFollowTokens.clear();
    this.sharedFollows.clear();
    this.upstreamFollowTokens.clear();
    this.upstream?.disconnect();
    this.upstream = null;
  }

  private handleLocalFollowRequest(session: Session, request: JsonRpcRequest): void {
    const followKey = JSON.stringify(request.params ?? []);
    const existing = this.sharedFollows.get(followKey);
    const sharedFollow: SharedFollow = existing ?? {
      key: followKey,
      upstreamToken: null,
      localTokens: new Set<string>(),
      pendingLocals: [],
      snapshot: createFollowSnapshot(),
    };
    if (existing === undefined) {
      this.sharedFollows.set(followKey, sharedFollow);
    }

    const localToken = `follow:${this.tokenCounter.toString(36)}:${session.id}`;
    this.tokenCounter += 1;
    this.localFollowTokens.set(localToken, { sessionId: session.id, followKey });
    session.ownedTokens.add(localToken);
    sharedFollow.localTokens.add(localToken);

    if (sharedFollow.upstreamToken !== null) {
      if (request.id !== undefined) {
        this.sendToSession(session, buildJsonRpcResult(request.id ?? null, localToken));
      }
      this.replayFollowSnapshot(session, localToken, sharedFollow);
      return;
    }

    sharedFollow.pendingLocals.push({ sessionId: session.id, requestId: request.id ?? null, localToken });
    // Asked for once, as it is created. Until the answer, every later session waits on that one request.
    if (existing === undefined) {
      this.sendTracked({ kind: 'follow', follow: sharedFollow }, request);
    }
  }

  private handleLocalUnfollowRequest(session: Session, request: JsonRpcRequest): void {
    const token = Array.isArray(request.params) && typeof request.params[0] === 'string' ? request.params[0] : null;
    if (token === null) {
      this.sendToSession(session, buildJsonRpcError(request.id ?? null, 'Unknown subscription/token'));
      return;
    }

    const followToken = this.localFollowTokens.get(token);
    if (followToken) {
      if (followToken.sessionId !== session.id) {
        this.sendToSession(session, buildJsonRpcError(request.id ?? null, 'Unknown subscription/token'));
        return;
      }
      this.releaseLocalFollowToken(token);
      if (request.id !== undefined) {
        this.sendToSession(session, buildJsonRpcResult(request.id ?? null, null));
      }
      return;
    }

    const rewritten = this.rewriteOwnedToken(session, request);
    if (rewritten === null) {
      this.sendToSession(session, buildJsonRpcError(request.id ?? null, 'Unknown subscription/token'));
      return;
    }
    this.forwardForSession(session, rewritten, request.method as string);
  }

  /**
   * Drops the follow and releases its tokens before any session hears the `stop`. papi re-follows
   * inside that delivery, and bound to the dead follow it would be stopped again without end.
   */
  private stopSharedFollow(sharedFollow: SharedFollow, upstreamToken: string, message: SubscriptionMessage): void {
    brokerLog(
      `Shared follow stopped by upstream; clearing for re-follow: key=${sharedFollow.key} token=${upstreamToken.slice(0, 12)}…`,
    );
    this.dropSharedFollow(sharedFollow);
    const recipients: { session: Session; localToken: string }[] = [];
    for (const localToken of sharedFollow.localTokens) {
      const session = this.sessions.get(this.localFollowTokens.get(localToken)?.sessionId ?? '');
      // The shared follow is gone, so nothing goes upstream for a follow the node already ended.
      this.releaseLocalFollowToken(localToken);
      if (session?.connected === true) {
        recipients.push({ session, localToken });
      }
    }
    for (const { session, localToken } of recipients) {
      brokerLog(`← subscription [${session.id}] event=stop method=${String(message.method)}`);
      this.sendToSession(session, { ...message, params: { ...message.params, subscription: localToken } });
    }
  }

  private releaseLocalFollowToken(localToken: string): void {
    const followToken = this.localFollowTokens.get(localToken);
    if (!followToken) {
      return;
    }

    this.localFollowTokens.delete(localToken);
    const session = this.sessions.get(followToken.sessionId);
    session?.ownedTokens.delete(localToken);

    const sharedFollow = this.sharedFollows.get(followToken.followKey);
    if (!sharedFollow) {
      return;
    }

    sharedFollow.localTokens.delete(localToken);
    sharedFollow.pendingLocals = sharedFollow.pendingLocals.filter(
      pendingLocal => pendingLocal.localToken !== localToken,
    );

    const upstreamToken = sharedFollow.upstreamToken;
    const orphaned = sharedFollow.snapshot.release(localToken, null);
    // Not answered yet, so it stays for the sessions that join before its answer.
    if (upstreamToken === null) {
      return;
    }
    // A live follow unpins orphaned blocks upstream. For the last token the unfollow below releases them all.
    if (sharedFollow.localTokens.size > 0) {
      if (orphaned.length > 0) {
        this.sendRelease('chainHead_v1_unpin', [upstreamToken, orphaned]);
      }
      return;
    }
    this.dropSharedFollow(sharedFollow);
    this.sendRelease('chainHead_v1_unfollow', [upstreamToken]);
  }

  private replayFollowSnapshot(session: Session, localToken: string, sharedFollow: SharedFollow): void {
    for (const result of sharedFollow.snapshot.replayFor(localToken)) {
      this.sendToSession(session, {
        jsonrpc: '2.0',
        method: 'chainHead_v1_followEvent',
        params: { subscription: localToken, result },
      });
    }
  }
}
