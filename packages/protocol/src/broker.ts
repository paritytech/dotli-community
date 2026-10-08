// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type {
  JsonRpcConnection,
  JsonRpcProvider,
  JsonRpcRequest as UpstreamJsonRpcRequest,
} from '@polkadot-api/json-rpc-provider';
import { log } from '@dotli/shared';
import { chainHaltedError } from './chain-halted.js';
import { decodeHeaderNumber } from './header-number.js';

/** `connectRemote`'s connection, typed as strings to match the postMessage wire. */
export interface StringJsonRpcConnection {
  send: (message: string) => void;
  disconnect: () => void;
}

/** Watches a broker's shared follows without being a session, so it holds nothing open. */
export interface BrokerObserver {
  /** The broker went from no established shared follow to one, or back. */
  onFollowing(following: boolean): void;
  /** A new best block on the reporting follow. A reorg can repeat a number or go lower. */
  onBestBlock(blockNumber: number): void;
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

interface PendingRequest {
  sessionId: string;
  clientId: JsonRpcId;
  method: string;
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
  requestInFlight: boolean;
  localTokens: Set<string>;
  pendingLocals: {
    sessionId: string;
    requestId: JsonRpcId;
    localToken: string;
  }[];
  /** The newest finalized block alone, the base a later session's replay starts from. */
  finalizedBlockHashes: string[];
  finalizedBlockRuntime: unknown;
  bestBlockHash: string | null;
  /** The unfinalized blocks above the newest finalized one. */
  blocks: Map<string, CachedBlock>;
  /** Per block hash, the local follow tokens (and the snapshot) still pinning it. */
  pins: Map<string, Set<string>>;
  /**
   * The newest finalized block's number, once its header arrives. Only the reporting follow fetches it, and a follow
   * that has stopped reporting keeps advancing it on each finalization it can place.
   */
  finalizedNumber: number | null;
  baseRequested: boolean;
}

/**
 * Pins the blocks a later session is replayed. Sessions unpin freely, and without this the next
 * session to join would be told of a block the node already unpinned and refuses to read.
 */
const SNAPSHOT_HOLDER = 'snapshot';

interface CachedBlock {
  result: Record<string, unknown>;
  parentBlockHash: string | null;
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

function isJsonRpcObject(value: unknown): value is Record<string, unknown> & { jsonrpc?: string } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeUpstreamError(error: unknown): string {
  if (!isJsonRpcObject(error)) {
    return 'malformed header';
  }
  return `${String(error['code'])} ${String(error['message'])}`;
}

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
  return isJsonRpcObject(value) && typeof value['method'] === 'string';
}

function isResponseMessage(value: unknown): value is JsonRpcResponse {
  return isJsonRpcObject(value) && 'id' in value && !('method' in value);
}

function isSubscriptionMessage(value: unknown): value is SubscriptionMessage {
  return (
    isJsonRpcObject(value) && 'method' in value && isJsonRpcObject(value['params']) && 'subscription' in value['params']
  );
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
  if (typeof param === 'string') {
    return [param];
  }
  if (Array.isArray(param)) {
    return param.filter((hash): hash is string => typeof hash === 'string');
  }
  return [];
}

function cloneWithRewrittenFirstParam(request: JsonRpcRequest, rewrittenToken: string): JsonRpcRequest {
  const params: unknown[] = Array.isArray(request.params) ? [...(request.params as unknown[])] : [];
  params[0] = rewrittenToken;
  return { ...request, params };
}

function releaseResultFor(method: string): unknown {
  return method === 'statement_unsubscribeStatement' ? true : null;
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
const warnCounts = new Map<string, number>();

function brokerWarn(kind: string, message: string): void {
  const count = (warnCounts.get(kind) ?? 0) + 1;
  warnCounts.set(kind, count);
  if (count <= WARN_IN_FULL) {
    log.warn(`${BROKER_TAG} ${message}`);
  } else if (/^10+$/.test(String(count))) {
    log.warn(`${BROKER_TAG} ${kind}: ${String(count)} so far`);
  }
}

export class ChainBroker {
  private readonly provider: JsonRpcProvider;
  private readonly onEmpty: () => void;
  private upstream: JsonRpcConnection | null = null;
  private readonly sessions = new Map<string, Session>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly localToOwned = new Map<string, OwnedToken>();
  private readonly upstreamToOwned = new Map<string, Set<string>>();
  private readonly earlySubscriptions = new Map<string, SubscriptionMessage[]>();
  private readonly localFollowTokens = new Map<string, { sessionId: string; followKey: string }>();
  private readonly sharedFollows = new Map<string, SharedFollow>();
  private readonly upstreamFollowTokens = new Map<string, SharedFollow>();
  private requestCounter = 0;
  private tokenCounter = 0;
  private observer: BrokerObserver | null = null;
  private following = false;
  /** Header requests the broker sends itself for a follow's base number, by upstream id. */
  private readonly baseRequests = new Map<string, { follow: SharedFollow; hash: string }>();

  constructor(provider: JsonRpcProvider, onEmpty: () => void) {
    this.provider = provider;
    this.onEmpty = onEmpty;
  }

  /** One observer per broker. One set while a follow is established hears it at once, and its base is fetched. */
  observe(observer: BrokerObserver | null): void {
    this.observer = observer;
    if (observer === null) {
      return;
    }
    if (this.following) {
      observer.onFollowing(true);
    }
    this.ensureBase();
  }

  private sendToSession(session: Session, obj: unknown): void {
    session.onMessage(encode(obj, session.wireMode));
  }

  private sendUpstream(obj: unknown): void {
    this.upstream?.send(obj as UpstreamJsonRpcRequest);
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
    this.onEmpty();
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
      try {
        this.answerHaltedSession(session);
        // eslint-disable-next-line no-restricted-syntax -- a throwing message handler must not keep its session from hearing the halt.
      } catch {
        /* the session still hears the halt */
      }
      session.connected = false;
      try {
        session.onHalt?.(error);
        // eslint-disable-next-line no-restricted-syntax -- defensive multicast: one session's handler must not keep the others from hearing the halt.
      } catch {
        /* the other sessions still hear the halt */
      }
    }
    this.disconnectUpstream();
    this.onEmpty();
  }

  private answerHaltedSession(session: Session): void {
    for (const entry of this.pending.values()) {
      if (entry.sessionId === session.id && entry.clientId !== null) {
        this.sendToSession(session, buildJsonRpcError(entry.clientId, chainHaltedError()));
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
      brokerWarn('session_not_connected', `sendFromSession: session ${sessionId} not connected, dropping message`);
      return;
    }

    let parsed: unknown;
    try {
      parsed = parseInbound(message);
    } catch {
      brokerWarn('session_invalid_json', `sendFromSession: invalid JSON from session ${sessionId}`);
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
      brokerWarn('session_not_request', `sendFromSession: not a request from session ${sessionId}`);
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
      brokerWarn(
        'request_unknown_token',
        `routeGenericRequest: unknown token for session ${session.id}, method=${method}`,
      );
      this.sendToSession(session, buildJsonRpcError(request.id ?? null, 'Unknown subscription/token'));
      return;
    }

    if (request.id === undefined) {
      this.sendUpstream(rewritten);
      return;
    }

    const upstreamId = `broker:${this.requestCounter.toString(36)}:${session.id}`;
    this.requestCounter += 1;
    this.pending.set(upstreamId, {
      sessionId: session.id,
      clientId: request.id ?? null,
      method,
    });
    this.sendUpstream({ ...rewritten, id: upstreamId });
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

    const rewritten = cloneWithRewrittenFirstParam(request, upstreamToken);
    if (request.id === undefined) {
      this.sendUpstream(rewritten);
      return;
    }

    const upstreamId = `broker:${this.requestCounter.toString(36)}:${session.id}`;
    this.requestCounter += 1;
    this.pending.set(upstreamId, {
      sessionId: session.id,
      clientId: request.id ?? null,
      method,
    });
    this.sendUpstream({ ...rewritten, id: upstreamId });
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

    const orphaned = this.releasePins(sharedFollow, token, normalizeUnpinHashes(params[1]));
    if (orphaned.length > 0) {
      this.sendUpstreamUnpin(sharedFollow.upstreamToken, orphaned);
    }

    if (request.id !== undefined) {
      this.sendToSession(session, buildJsonRpcResult(request.id ?? null, null));
    }
  }

  private registerPin(sharedFollow: SharedFollow, localToken: string, hash: string): void {
    let holders = sharedFollow.pins.get(hash);
    if (!holders) {
      holders = new Set<string>();
      sharedFollow.pins.set(hash, holders);
    }
    holders.add(localToken);
  }

  /** Pin the blocks a follow event implies: `initialized` finalized blocks and `newBlock`. */
  private registerPinsFromEvent(sharedFollow: SharedFollow, localToken: string, eventResult: unknown): void {
    if (!isJsonRpcObject(eventResult)) {
      return;
    }
    if (eventResult['event'] === 'initialized') {
      const hashes = Array.isArray(eventResult['finalizedBlockHashes']) ? eventResult['finalizedBlockHashes'] : [];
      for (const hash of hashes) {
        if (typeof hash === 'string') {
          this.registerPin(sharedFollow, localToken, hash);
        }
      }
      return;
    }
    if (eventResult['event'] === 'newBlock' && typeof eventResult['blockHash'] === 'string') {
      this.registerPin(sharedFollow, localToken, eventResult['blockHash']);
    }
  }

  /** Drops `localToken`'s hold on `hashes` (all when null) and returns those no session holds anymore. */
  private releasePins(sharedFollow: SharedFollow, localToken: string, hashes: string[] | null): string[] {
    const orphaned: string[] = [];
    const entries = hashes ?? [...sharedFollow.pins.keys()];
    for (const hash of entries) {
      const holders = sharedFollow.pins.get(hash);
      if (!holders) {
        continue;
      }
      if (!holders.delete(localToken)) {
        continue;
      }
      if (holders.size === 0) {
        sharedFollow.pins.delete(hash);
        orphaned.push(hash);
      }
    }
    return orphaned;
  }

  private sendUpstreamUnpin(upstreamToken: string, hashes: string[]): void {
    this.sendUpstream({
      jsonrpc: '2.0',
      id: `broker-release:${this.requestCounter.toString(36)}`,
      method: 'chainHead_v1_unpin',
      params: [upstreamToken, hashes],
    });
    this.requestCounter += 1;
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
      brokerWarn('upstream_unparseable', `← upstream: unparseable message of ${String(size)} chars (${reason})`);
      if (typeof message === 'string') {
        const idMatch = /"id"\s*:\s*("?)([^",}\s]+)\1/.exec(message);
        const matchedId = idMatch?.[2];
        if (matchedId !== undefined) {
          const candidates = [matchedId];
          for (const idKey of candidates) {
            const pending = this.pending.get(idKey);
            if (pending !== undefined) {
              this.pending.delete(idKey);
              const session = this.sessions.get(pending.sessionId);
              if (session !== undefined) {
                this.sendToSession(
                  session,
                  buildJsonRpcError(pending.clientId, `Upstream returned unparseable response: ${reason}`),
                );
              }
              break;
            }
          }
        }
      }
      return;
    }

    if (Array.isArray(parsed)) {
      brokerWarn('upstream_batch', `← upstream: unexpected batch message, ignoring`);
      return;
    }

    if (isSubscriptionMessage(parsed)) {
      const result = parsed.params?.result;
      if (isJsonRpcObject(result)) {
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

    brokerWarn('upstream_unrecognized', `← upstream: unrecognized message type`);
  }

  private handleUpstreamResponse(response: JsonRpcResponse): void {
    const base = this.baseRequests.get(String(response.id));
    if (base !== undefined) {
      this.baseRequests.delete(String(response.id));
      this.settleBase(base.follow, base.hash, response);
      return;
    }
    const pending = this.pending.get(String(response.id));
    if (!pending) {
      brokerWarn('response_unknown_id', `← upstream response for unknown id=${String(response.id)}`);
      return;
    }
    this.pending.delete(String(response.id));

    const hasError = 'error' in response;
    const resultPreview = hasError
      ? `error=${JSON.stringify(response.error)}`
      : typeof response.result === 'string' && response.result.length > 200
        ? `result=${response.result.slice(0, 200)}... (${String(response.result.length)} chars)`
        : `result=${JSON.stringify(response.result)}`;
    brokerLog(`← upstream [${pending.sessionId}] method=${pending.method} ${resultPreview}`);

    // chainHead_v1_follow responses use the follow key (not a session ID)
    // as pending.sessionId, so handle before the session connectivity check.
    if (pending.method === 'chainHead_v1_follow' && typeof response.result === 'string') {
      const sharedFollow = this.sharedFollows.get(pending.sessionId);
      if (!sharedFollow) {
        brokerWarn('follow_state_missing', `Missing shared follow state for key ${pending.sessionId}`);
        return;
      }
      sharedFollow.requestInFlight = false;
      sharedFollow.upstreamToken = response.result;
      this.upstreamFollowTokens.set(response.result, sharedFollow);
      this.syncFollowing();
      for (const pendingLocal of sharedFollow.pendingLocals.splice(0)) {
        const pendingSession = this.sessions.get(pendingLocal.sessionId);
        if (pendingSession?.connected !== true) {
          continue;
        }
        this.sendToSession(pendingSession, buildJsonRpcResult(pendingLocal.requestId, pendingLocal.localToken));
      }
      this.flushEarlySubscriptions(response.result);
      return;
    }

    const session = this.sessions.get(pending.sessionId);
    if (session?.connected !== true) {
      brokerWarn(
        'response_disconnected_session',
        `← upstream response for disconnected session: sessionId=${JSON.stringify(pending.sessionId)}, method=${pending.method}, responseId=${String(response.id)}, sessions=[${[...this.sessions.keys()].join(',')}]`,
      );
      return;
    }

    let result: unknown = response.result;
    const releaseMethod = TOKEN_METHODS.get(pending.method);
    if (releaseMethod !== undefined && typeof response.result === 'string') {
      const localToken = `token:${this.tokenCounter.toString(36)}:${pending.sessionId}`;
      this.tokenCounter += 1;
      const owned: OwnedToken = {
        sessionId: pending.sessionId,
        localToken,
        upstreamToken: response.result,
        releaseMethod,
      };
      this.localToOwned.set(localToken, owned);
      let localTokens = this.upstreamToOwned.get(response.result);
      if (localTokens === undefined) {
        localTokens = new Set<string>();
        this.upstreamToOwned.set(response.result, localTokens);
      }
      localTokens.add(localToken);
      session.ownedTokens.add(localToken);
      brokerLog(`Token mapped: ${localToken} ↔ ${response.result} (${pending.method})`);
      result = localToken;
    }

    const rewritten: Record<string, unknown> = {
      ...response,
      id: pending.clientId,
    };
    if ('result' in response) {
      rewritten['result'] = result;
    }
    this.sendToSession(session, rewritten);
    if (releaseMethod !== undefined && typeof response.result === 'string') {
      this.flushEarlySubscriptions(response.result);
    }
  }

  private handleUpstreamSubscription(message: SubscriptionMessage): void {
    const upstreamToken = message.params?.subscription;
    if (typeof upstreamToken !== 'string') {
      brokerWarn('subscription_bad_token', `← upstream subscription with non-string token`);
      return;
    }

    const sharedFollow = this.upstreamFollowTokens.get(upstreamToken);
    if (sharedFollow) {
      const eventResult = message.params?.result;
      if (isJsonRpcObject(eventResult) && eventResult['event'] === 'stop') {
        this.stopSharedFollow(sharedFollow, upstreamToken, message);
        return;
      }
      this.cacheSharedFollowEvent(sharedFollow, eventResult);
      for (const localToken of sharedFollow.localTokens) {
        const local = this.localFollowTokens.get(localToken);
        if (!local) {
          continue;
        }
        const session = this.sessions.get(local.sessionId);
        if (session?.connected !== true) {
          continue;
        }
        this.registerPinsFromEvent(sharedFollow, localToken, eventResult);
        const eventType = isJsonRpcObject(eventResult)
          ? typeof eventResult['event'] === 'string'
            ? eventResult['event']
            : 'unknown'
          : '?';
        brokerLog(`← subscription [${local.sessionId}] event=${eventType} method=${String(message.method)}`);
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
      brokerWarn('subscription_unknown_token', `← upstream subscription for unknown token: ${upstreamToken}`);
      return;
    }

    const eventResult = message.params?.result;
    const eventType = isJsonRpcObject(eventResult)
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
        brokerWarn(
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

    if (isJsonRpcObject(eventResult) && eventResult['event'] === 'stop') {
      brokerLog(`Token stopped by upstream: ${upstreamToken}`);
      for (const localToken of localTokens) {
        this.releaseOwnedToken(localToken, false);
      }
    }
  }

  private hasPendingSubscriptionRequest(): boolean {
    return [...this.pending.values()].some(
      ({ method }) => method === 'chainHead_v1_follow' || TOKEN_METHODS.has(method),
    );
  }

  private bufferEarlySubscription(upstreamToken: string, message: SubscriptionMessage): void {
    let events = this.earlySubscriptions.get(upstreamToken);
    if (events === undefined) {
      if (this.earlySubscriptions.size >= MAX_EARLY_SUBSCRIPTION_TOKENS) {
        const oldestToken = this.earlySubscriptions.keys().next().value;
        if (oldestToken !== undefined) {
          this.earlySubscriptions.delete(oldestToken);
          brokerWarn(
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
      brokerWarn('early_event_cap', `early-subscription event cap hit; dropping event for token: ${upstreamToken}`);
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

    for (const requestId of [...this.pending.keys()]) {
      if (this.pending.get(requestId)?.sessionId === sessionId) {
        this.pending.delete(requestId);
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

    if (!notifyUpstream) {
      return { lastOwner: true };
    }

    this.sendUpstream({
      jsonrpc: '2.0',
      id: `broker-release:${this.requestCounter.toString(36)}`,
      method: owned.releaseMethod,
      params: [owned.upstreamToken],
    });
    this.requestCounter += 1;
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
    this.baseRequests.clear();
    this.upstream?.disconnect();
    this.upstream = null;
    this.syncFollowing();
  }

  private handleLocalFollowRequest(session: Session, request: JsonRpcRequest): void {
    const followKey = JSON.stringify(request.params ?? []);
    let sharedFollow = this.sharedFollows.get(followKey);
    if (!sharedFollow) {
      sharedFollow = {
        key: followKey,
        upstreamToken: null,
        requestInFlight: false,
        localTokens: new Set<string>(),
        pendingLocals: [],
        finalizedBlockHashes: [],
        finalizedBlockRuntime: null,
        bestBlockHash: null,
        blocks: new Map<string, CachedBlock>(),
        pins: new Map<string, Set<string>>(),
        finalizedNumber: null,
        baseRequested: false,
      };
      this.sharedFollows.set(followKey, sharedFollow);
    }

    const localToken = `follow:${this.tokenCounter.toString(36)}:${session.id}`;
    this.tokenCounter += 1;
    this.localFollowTokens.set(localToken, {
      sessionId: session.id,
      followKey,
    });
    session.ownedTokens.add(localToken);
    sharedFollow.localTokens.add(localToken);

    if (sharedFollow.upstreamToken !== null) {
      if (request.id !== undefined) {
        this.sendToSession(session, buildJsonRpcResult(request.id ?? null, localToken));
      }
      this.replayFollowSnapshot(session, localToken, sharedFollow);
      return;
    }

    sharedFollow.pendingLocals.push({
      sessionId: session.id,
      requestId: request.id ?? null,
      localToken,
    });

    if (sharedFollow.requestInFlight) {
      return;
    }

    sharedFollow.requestInFlight = true;
    const upstreamId = `broker:${this.requestCounter.toString(36)}:${followKey}`;
    this.requestCounter += 1;
    this.pending.set(upstreamId, {
      sessionId: followKey,
      clientId: request.id ?? null,
      method: 'chainHead_v1_follow',
    });
    this.sendUpstream({ ...request, id: upstreamId });
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
    if (request.id === undefined) {
      this.sendUpstream(rewritten);
      return;
    }

    const upstreamId = `broker:${this.requestCounter.toString(36)}:${session.id}`;
    this.requestCounter += 1;
    this.pending.set(upstreamId, {
      sessionId: session.id,
      clientId: request.id ?? null,
      method: request.method as string,
    });
    this.sendUpstream({ ...rewritten, id: upstreamId });
  }

  /**
   * Drops the follow and releases its tokens before any session hears the `stop`. papi re-follows
   * inside that delivery, and bound to the dead follow it would be stopped again without end.
   */
  private stopSharedFollow(sharedFollow: SharedFollow, upstreamToken: string, message: SubscriptionMessage): void {
    brokerLog(
      `Shared follow stopped by upstream; clearing for re-follow: key=${sharedFollow.key} token=${upstreamToken.slice(0, 12)}…`,
    );
    this.upstreamFollowTokens.delete(upstreamToken);
    this.sharedFollows.delete(sharedFollow.key);
    this.syncFollowing();
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

    const followStaysAlive = sharedFollow.localTokens.size > 0 || sharedFollow.requestInFlight;

    // A live follow unpins orphaned blocks upstream. For the last token the unfollow below releases them all.
    const orphaned = this.releasePins(sharedFollow, localToken, null);
    if (followStaysAlive) {
      if (orphaned.length > 0 && sharedFollow.upstreamToken !== null) {
        this.sendUpstreamUnpin(sharedFollow.upstreamToken, orphaned);
      }
      return;
    }

    if (sharedFollow.upstreamToken !== null) {
      this.upstreamFollowTokens.delete(sharedFollow.upstreamToken);
      this.sendUpstream({
        jsonrpc: '2.0',
        id: `broker-release:${this.requestCounter.toString(36)}`,
        method: 'chainHead_v1_unfollow',
        params: [sharedFollow.upstreamToken],
      });
      this.requestCounter += 1;
    }

    this.sharedFollows.delete(followToken.followKey);
    this.syncFollowing();
  }

  private cacheSharedFollowEvent(sharedFollow: SharedFollow, eventResult: unknown): void {
    if (!isJsonRpcObject(eventResult)) {
      return;
    }

    const eventType = typeof eventResult['event'] === 'string' ? eventResult['event'] : '';
    if (eventType === 'initialized') {
      const hashes = Array.isArray(eventResult['finalizedBlockHashes'])
        ? eventResult['finalizedBlockHashes'].filter((hash): hash is string => typeof hash === 'string')
        : [];
      const newest = hashes.at(-1);
      sharedFollow.finalizedBlockHashes = newest === undefined ? [] : [newest];
      sharedFollow.finalizedBlockRuntime = eventResult['finalizedBlockRuntime'] ?? null;
      sharedFollow.blocks.clear();
      sharedFollow.bestBlockHash = null;
      if (newest !== undefined) {
        this.registerPin(sharedFollow, SNAPSHOT_HOLDER, newest);
      }
      this.ensureBase();
      return;
    }

    if (eventType === 'newBlock') {
      const blockHash = typeof eventResult['blockHash'] === 'string' ? eventResult['blockHash'] : null;
      if (blockHash === null) {
        return;
      }
      sharedFollow.blocks.set(blockHash, {
        result: { ...eventResult },
        parentBlockHash: typeof eventResult['parentBlockHash'] === 'string' ? eventResult['parentBlockHash'] : null,
      });
      this.registerPin(sharedFollow, SNAPSHOT_HOLDER, blockHash);
      return;
    }

    if (eventType === 'bestBlockChanged') {
      sharedFollow.bestBlockHash =
        typeof eventResult['bestBlockHash'] === 'string' ? eventResult['bestBlockHash'] : null;
      this.reportBest(sharedFollow);
      return;
    }

    if (eventType === 'finalized') {
      const hashes = Array.isArray(eventResult['finalizedBlockHashes'])
        ? eventResult['finalizedBlockHashes'].filter((hash): hash is string => typeof hash === 'string')
        : [];
      const newest = hashes.at(-1);
      if (newest === undefined) {
        return;
      }
      const newestNumber = sharedFollow.finalizedNumber === null ? null : this.blockNumberOf(sharedFollow, newest);
      for (const hash of hashes) {
        const newRuntime = sharedFollow.blocks.get(hash)?.result['newRuntime'];
        if (newRuntime !== undefined && newRuntime !== null) {
          sharedFollow.finalizedBlockRuntime = newRuntime;
        }
      }
      const pruned = Array.isArray(eventResult['prunedBlockHashes'])
        ? eventResult['prunedBlockHashes'].filter((hash): hash is string => typeof hash === 'string')
        : [];
      const dropped = [...sharedFollow.finalizedBlockHashes, ...hashes.slice(0, -1), ...pruned];
      for (const hash of [...dropped, newest]) {
        sharedFollow.blocks.delete(hash);
      }
      this.registerPin(sharedFollow, SNAPSHOT_HOLDER, newest);
      sharedFollow.finalizedBlockHashes = [newest];
      if (sharedFollow.finalizedNumber !== null) {
        sharedFollow.finalizedNumber = newestNumber;
        if (newestNumber === null) {
          // A finalized block the cache cannot place, so its number is fetched again.
          sharedFollow.baseRequested = false;
          this.ensureBase();
        }
      }
      const orphaned = this.releasePins(sharedFollow, SNAPSHOT_HOLDER, dropped);
      if (orphaned.length > 0 && sharedFollow.upstreamToken !== null) {
        this.sendUpstreamUnpin(sharedFollow.upstreamToken, orphaned);
      }
    }
  }

  private replayFollowSnapshot(session: Session, localToken: string, sharedFollow: SharedFollow): void {
    if (sharedFollow.finalizedBlockHashes.length > 0) {
      for (const hash of sharedFollow.finalizedBlockHashes) {
        this.registerPin(sharedFollow, localToken, hash);
      }
      this.sendToSession(session, {
        jsonrpc: '2.0',
        method: 'chainHead_v1_followEvent',
        params: {
          subscription: localToken,
          result: {
            event: 'initialized',
            finalizedBlockHashes: sharedFollow.finalizedBlockHashes,
            finalizedBlockRuntime: sharedFollow.finalizedBlockRuntime,
          },
        },
      });
    }

    const replayBlocks: Record<string, unknown>[] = [];
    let cursor = sharedFollow.bestBlockHash;
    const seen = new Set<string>();
    while (cursor !== null && !seen.has(cursor)) {
      seen.add(cursor);
      const cached = sharedFollow.blocks.get(cursor);
      if (!cached) {
        break;
      }
      replayBlocks.push(cached.result);
      if (cached.parentBlockHash === null || sharedFollow.finalizedBlockHashes.includes(cached.parentBlockHash)) {
        break;
      }
      cursor = cached.parentBlockHash;
    }

    replayBlocks.reverse();
    for (const result of replayBlocks) {
      this.registerPinsFromEvent(sharedFollow, localToken, result);
      this.sendToSession(session, {
        jsonrpc: '2.0',
        method: 'chainHead_v1_followEvent',
        params: {
          subscription: localToken,
          result,
        },
      });
    }

    if (sharedFollow.bestBlockHash !== null) {
      this.sendToSession(session, {
        jsonrpc: '2.0',
        method: 'chainHead_v1_followEvent',
        params: {
          subscription: localToken,
          result: {
            event: 'bestBlockChanged',
            bestBlockHash: sharedFollow.bestBlockHash,
          },
        },
      });
    }
  }

  /**
   * The first follow in insertion order that has its upstream token. Only it reports, so two follows never report one
   * block twice.
   */
  private reportingFollow(): SharedFollow | null {
    for (const sharedFollow of this.sharedFollows.values()) {
      if (sharedFollow.upstreamToken !== null) {
        return sharedFollow;
      }
    }
    return null;
  }

  private syncFollowing(): void {
    const following = this.reportingFollow() !== null;
    if (following !== this.following) {
      this.following = following;
      this.observer?.onFollowing(following);
    }
    this.ensureBase();
  }

  private ensureBase(): void {
    const sharedFollow = this.reportingFollow();
    const hash = sharedFollow?.finalizedBlockHashes.at(-1);
    const token = sharedFollow?.upstreamToken;
    if (
      this.observer === null ||
      sharedFollow === null ||
      token === undefined ||
      token === null ||
      sharedFollow.baseRequested ||
      hash === undefined
    ) {
      return;
    }
    sharedFollow.baseRequested = true;
    const id = `broker-base:${this.requestCounter.toString(36)}`;
    this.requestCounter += 1;
    this.baseRequests.set(id, { follow: sharedFollow, hash });
    this.sendUpstream({
      jsonrpc: '2.0',
      id,
      method: 'chainHead_v1_header',
      params: [token, hash],
    });
  }

  private settleBase(sharedFollow: SharedFollow, hash: string, response: JsonRpcResponse): void {
    // A follow that ended meanwhile, replaced or not, is not this one.
    if (this.sharedFollows.get(sharedFollow.key) !== sharedFollow) {
      return;
    }
    // First, since the node may refuse the old base only because it was unpinned. One retry per finalization.
    if (sharedFollow.finalizedBlockHashes.at(-1) !== hash) {
      sharedFollow.baseRequested = false;
      this.ensureBase();
      return;
    }
    const blockNumber = typeof response.result === 'string' ? decodeHeaderNumber(response.result) : null;
    if (blockNumber === null) {
      brokerWarn(
        'base_header_unreadable',
        `base header for ${hash.slice(0, 18)}… unreadable (${describeUpstreamError(response.error)}), best blocks go unreported`,
      );
      return;
    }
    sharedFollow.finalizedNumber = blockNumber;
    this.reportBest(sharedFollow);
  }

  /** Walks parent links down to the newest finalized block. Null when the cache cannot place the block. */
  private blockNumberOf(sharedFollow: SharedFollow, hash: string): number | null {
    const finalized = sharedFollow.finalizedBlockHashes.at(-1);
    if (sharedFollow.finalizedNumber === null || finalized === undefined) {
      return null;
    }
    let depth = 0;
    let cursor: string | null = hash;
    const seen = new Set<string>();
    while (cursor !== null && cursor !== finalized) {
      if (seen.has(cursor)) {
        return null;
      }
      seen.add(cursor);
      const cached = sharedFollow.blocks.get(cursor);
      if (cached === undefined) {
        return null;
      }
      depth += 1;
      cursor = cached.parentBlockHash;
    }
    return cursor === finalized ? sharedFollow.finalizedNumber + depth : null;
  }

  private reportBest(sharedFollow: SharedFollow): void {
    if (this.observer === null || sharedFollow !== this.reportingFollow() || sharedFollow.bestBlockHash === null) {
      return;
    }
    const blockNumber = this.blockNumberOf(sharedFollow, sharedFollow.bestBlockHash);
    if (blockNumber !== null) {
      this.observer.onBestBlock(blockNumber);
    }
  }
}
