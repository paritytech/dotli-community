// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type {
  JsonRpcConnection,
  JsonRpcProvider,
  JsonRpcRequest as UpstreamJsonRpcRequest,
} from '@polkadot-api/json-rpc-provider';
import { createReporter, defineCount } from '@dotli/metrics';
import { getErrorMessage, isRecord, runEvery } from '@dotli/shared';
import {
  buildFollowEvent,
  buildJsonRpcResult,
  cloneWithRewrittenFirstParam,
  DEFAULT_WIRE_MODE,
  describeResponse,
  encodeForWire,
  getEventType,
  getReleaseResult,
  isRequestMessage,
  isResponseMessage,
  isSubscriptionEnd,
  isSubscriptionMessage,
  parseInboundMessage,
  readdressSubscription,
  RELEASE_METHODS,
  TOKEN_METHODS,
  type BrokerConnection,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type OwnedToken,
  type RequestOwner,
  type Session,
  type SubscriptionMessage,
  type WireMode,
} from './brokerMessages.js';
import { chainPoolCloseMetric } from './chainPoolCloseMetric.js';
import { createBrokerWarner, logBrokerTraffic, type BrokerWarner } from './createBrokerWarner.js';
import { createChainHaltedError } from './createChainHaltedError.js';
import { createEarlySubscriptions } from './createEarlySubscriptions.js';
import { createJsonRpcError } from './createJsonRpcError.js';
import { createOwnedTokens } from './createOwnedTokens.js';
import { createPendingRequests } from './createPendingRequests.js';
import { CHAIN_HEAD_FOLLOW, CHAIN_HEAD_UNFOLLOW } from './jsonRpcMethods.js';
import { readStrings } from './readStrings.js';

const report = createReporter({ flow: 'protocol' });

/**
 * Count. A `chainHead_v1_follow` the node refused. Tagged `outcome` (error) and `reason` (`limit` for error code
 * `-32800`, `refused` for any other).
 */
const chainFollowRefusedMetric = defineCount<'error'>('chain_broker.follow_refused');

/** Many JSON-RPC sessions over one upstream connection, with ids and subscription tokens rewritten per session. */
export type ChainBroker = ReturnType<typeof createChainBroker>;

type Params = {
  /** The upstream transport. Opened with the first session, closed by `disconnectAll` and `halt`. */
  provider: JsonRpcProvider;
  /** Passed by an owner that rebuilds brokers for one chain, so a rebuild keeps that chain's count. */
  warn?: BrokerWarner;
};

type ConnectParams = {
  /** Names the session in the local tokens it gets. Unique among the broker's open sessions. */
  sessionId: string;
  /** Hears each message for the session, encoded for its wire mode. */
  onMessage: (message: unknown) => void;
  /** How messages reach `onMessage`: JSON text by default, or the parsed objects. */
  wireMode?: WireMode;
  /** Told once when the chain's transport halts for good. */
  onHalt?: ((error?: unknown) => void) | null;
};

type ForwardForSessionParams = {
  /** The session that sent the request, and owns its answer. */
  session: Session;
  /** The request as it goes upstream, its tokens already rewritten. Its method decides how its answer is mapped. */
  request: JsonRpcRequest;
  /** The upstream token a release request ends, so events for it in the meantime are dropped quietly. */
  upstreamToken?: string;
};

/** Where the broker's upstream connection is in its life. A halt is final. */
type UpstreamState =
  { kind: 'closed' } | { kind: 'opening' } | { kind: 'open'; connection: JsonRpcConnection } | { kind: 'halted' };

type UnparseableUpstreamParams = {
  /** The upstream message as it arrived, JSON text or an object. */
  message: unknown;
  /** Why it did not parse. */
  reason: string;
};

// A session's handler that throws on the halt is a defect in its owner, reported while the other sessions still hear it.
const reportHaltListener = report.listener('chain_halt');

// The error code a node answers a follow with when the connection already holds as many follows as it allows.
const FOLLOW_LIMIT_ERROR_CODE = -32800;

/** Builds a broker that serves many JSON-RPC sessions over `provider`, opening it only with the first session. */
export function createChainBroker({ provider, warn = createBrokerWarner() }: Params) {
  let state: UpstreamState = { kind: 'closed' };
  const sessions = new Map<string, Session>();
  const pending = createPendingRequests({ sendUpstream });
  const earlySubscriptions = createEarlySubscriptions({ warn, deliver: handleUpstreamSubscription });
  const ownedTokens = createOwnedTokens();

  function connect({
    sessionId,
    onMessage,
    wireMode = DEFAULT_WIRE_MODE,
    onHalt = null,
  }: ConnectParams): BrokerConnection {
    if (sessions.has(sessionId)) {
      throw new Error(`Duplicate broker session: ${sessionId}`);
    }

    logBrokerTraffic(`Session ${sessionId} connecting (${String(sessions.size)} existing sessions)`);
    ensureUpstream();
    if (state.kind !== 'open') {
      return createUnservedConnection(sessionId);
    }
    sessions.set(sessionId, { id: sessionId, onMessage, wireMode, onHalt });

    return {
      send: message => {
        sendFromSession(sessionId, message);
      },
      disconnect: () => {
        disconnectSession(sessionId);
      },
    };
  }

  function disconnectAll(): void {
    runEvery(
      [
        ...[...sessions.keys()].map(sessionId => () => {
          disconnectSession(sessionId);
        }),
        disconnectUpstream,
      ],
      'chain broker: closing every session and the upstream failed',
    );
  }

  function halt(error?: unknown): void {
    const previous = state;
    state = { kind: 'halted' };
    const haltedSessions = [...sessions.values()];
    sessions.clear();
    for (const session of haltedSessions) {
      // A throwing message handler must not keep its session from hearing the halt.
      try {
        answerHaltedSession(session);
      } catch (thrown) {
        reportHaltListener(thrown);
      }
      // One session's handler must not keep the others from hearing the halt.
      try {
        session.onHalt?.(error);
      } catch (thrown) {
        reportHaltListener(thrown);
      }
    }
    releaseUpstream(previous);
  }

  function sendToSession(session: Pick<Session, 'onMessage' | 'wireMode'>, message: unknown): void {
    session.onMessage(encodeForWire(message, session.wireMode));
  }

  function sendUpstream(message: unknown): void {
    // The provider types its requests narrower than the messages the broker forwards.
    if (state.kind === 'open') {
      state.connection.send(message as UpstreamJsonRpcRequest);
    }
  }

  /**
   * Forwards a session's request, owned by the session when it expects an answer. A follow or an unfollow sent without
   * an id is still tracked, so the follows the node holds stay counted. Such a follow's answer is unfollowed at once.
   */
  function forwardForSession({ session, request, upstreamToken }: ForwardForSessionParams): void {
    const { method } = request;
    if (request.id !== undefined) {
      pending.track({
        owner: { kind: 'session', session, clientId: request.id, method, upstreamToken },
        request,
      });
      return;
    }
    if (method === CHAIN_HEAD_FOLLOW) {
      pending.track({ owner: { kind: 'orphan', method }, request });
      return;
    }
    if (method === CHAIN_HEAD_UNFOLLOW && upstreamToken !== undefined) {
      pending.track({ owner: { kind: 'release', method, upstreamToken }, request });
      return;
    }
    sendUpstream(request);
  }

  /** A release the broker sends itself, for something no session holds anymore. */
  function sendRelease({ releaseMethod, upstreamToken }: Pick<OwnedToken, 'releaseMethod' | 'upstreamToken'>): void {
    pending.track({
      owner: { kind: 'release', method: releaseMethod, upstreamToken },
      request: { jsonrpc: '2.0', method: releaseMethod, params: [upstreamToken] },
    });
  }

  function countFollows(): number {
    let inFlight = 0;
    for (const owner of pending.listOwners()) {
      const method = owner.method;
      if (method === CHAIN_HEAD_FOLLOW || method === CHAIN_HEAD_UNFOLLOW) {
        inFlight += 1;
      }
    }
    return ownedTokens.countUpstream(CHAIN_HEAD_UNFOLLOW) + inFlight;
  }

  function answerHaltedSession(session: Session): void {
    for (const owner of pending.listOwners()) {
      if (owner.kind === 'session' && owner.session === session && owner.clientId !== null) {
        sendToSession(session, createJsonRpcError(owner.clientId, createChainHaltedError()));
      }
    }
    for (const { localToken, releaseMethod } of ownedTokens.listSessionTokens(session)) {
      if (releaseMethod === CHAIN_HEAD_UNFOLLOW) {
        sendToSession(session, buildFollowEvent(localToken, { event: 'stop' }));
      }
    }
  }

  /** Opens the upstream from `closed`. Throws what the provider throws, and returns an unchanged `opening` to `closed`. */
  function ensureUpstream(): void {
    if (state.kind !== 'closed') {
      return;
    }
    logBrokerTraffic(`Connecting to upstream provider... (sessions: [${[...sessions.keys()].join(',')}])`);
    const opening: UpstreamState = { kind: 'opening' };
    state = opening;
    let connection: JsonRpcConnection;
    // The `open` member this call writes. A message from an upstream the broker closed or abandoned is dropped.
    let opened: UpstreamState | null = null;
    try {
      connection = provider(message => {
        if (state === opened) {
          handleUpstreamMessage(message);
        }
      });
    } catch (error) {
      if (state === opening) {
        state = { kind: 'closed' };
      }
      throw error;
    }
    // The transport may halt the broker, or its owner close it, from inside the provider call.
    if (state !== opening) {
      closeAbandonedUpstream(connection);
      return;
    }
    opened = { kind: 'open', connection };
    state = opened;
    logBrokerTraffic(
      `Upstream provider connected (send=${typeof connection.send}, disconnect=${typeof connection.disconnect})`,
    );
  }

  /** Closes an upstream the broker halted or closed while it opened. A failed close is reported, never thrown. */
  function closeAbandonedUpstream(connection: JsonRpcConnection): void {
    try {
      connection.disconnect();
    } catch (error) {
      report.defect(error, {
        step: 'chain_broker_close',
        metric: chainPoolCloseMetric,
        message: '[dot.li broker] closing an upstream that halted or closed while it opened failed:',
      });
    }
  }

  /** A connection for a session the broker cannot serve, which drops what it sends. */
  function createUnservedConnection(sessionId: string): BrokerConnection {
    logBrokerTraffic(`Session ${sessionId} not served, as the upstream is ${state.kind}`);
    return {
      send: () => {
        warnNotConnected(sessionId);
      },
      disconnect: () => undefined,
    };
  }

  function warnNotConnected(sessionId: string): void {
    warn('session_not_connected', `sendFromSession: session ${sessionId} not connected, dropping message`);
  }

  function sendFromSession(sessionId: string, message: unknown): void {
    const session = sessions.get(sessionId);
    // A session may answer the halt's stop with a new follow, which goes nowhere but is no anomaly.
    if (session === undefined && state.kind === 'halted') {
      logBrokerTraffic(`Dropped a message from ${sessionId}, as the chain halted`);
      return;
    }
    if (session === undefined) {
      warnNotConnected(sessionId);
      return;
    }

    let parsed: unknown;
    try {
      parsed = parseInboundMessage(message);
    } catch {
      warn('session_invalid_json', `sendFromSession: invalid JSON from session ${sessionId}`);
      sendToSession(session, createJsonRpcError(null, 'Invalid JSON-RPC payload'));
      return;
    }

    if (Array.isArray(parsed)) {
      sendToSession(session, createJsonRpcError(null, 'Batch JSON-RPC is unsupported'));
      return;
    }

    if (!isRequestMessage(parsed)) {
      warn('session_not_request', `sendFromSession: not a request from session ${sessionId}`);
      sendToSession(session, createJsonRpcError(null, 'Invalid JSON-RPC request'));
      return;
    }

    logBrokerTraffic(`to upstream [${sessionId}] method=${parsed.method} id=${String(parsed.id)}`);
    routeGenericRequest(session, parsed);
  }

  /** Rewrite a session-owned token to its upstream token and forward. */
  function routeGenericRequest(session: Session, request: JsonRpcRequest): void {
    const { method } = request;
    if (RELEASE_METHODS.has(method)) {
      routeOwnedReleaseRequest(session, request);
      return;
    }

    const rewritten = rewriteOwnedToken(session, request);
    if (rewritten === null) {
      warn('request_unknown_token', `routeGenericRequest: unknown token for session ${session.id}, method=${method}`);
      sendToSession(session, createJsonRpcError(request.id ?? null, 'Unknown subscription/token'));
      return;
    }

    forwardForSession({ session, request: rewritten });
  }

  function routeOwnedReleaseRequest(session: Session, request: JsonRpcRequest): void {
    const { method } = request;
    const owned = findOwnedToken(request);
    if (owned?.session !== session || owned.releaseMethod !== method) {
      sendToSession(session, createJsonRpcError(request.id ?? null, 'Unknown subscription/token'));
      return;
    }

    const { upstreamToken } = owned;
    if (!ownedTokens.release(owned.localToken)) {
      if (request.id !== undefined) {
        sendToSession(session, buildJsonRpcResult(request.id, getReleaseResult(method)));
      }
      return;
    }

    forwardForSession({
      session,
      request: cloneWithRewrittenFirstParam(request, upstreamToken),
      upstreamToken,
    });
  }

  function rewriteOwnedToken(session: Session, request: JsonRpcRequest): JsonRpcRequest | null {
    const owned = findOwnedToken(request);
    if (owned === undefined) {
      return request;
    }
    if (owned.session !== session) {
      return null;
    }

    return cloneWithRewrittenFirstParam(request, owned.upstreamToken);
  }

  /** The owned token a request names as its first param, or undefined when it names none. */
  function findOwnedToken(request: JsonRpcRequest): Readonly<OwnedToken> | undefined {
    const localToken: unknown = Array.isArray(request.params) ? request.params[0] : undefined;
    return typeof localToken === 'string' ? ownedTokens.find(localToken) : undefined;
  }

  function handleUpstreamMessage(message: unknown): void {
    // Strings too, since some substrate clients serialize inconsistently.
    let parsed: unknown;
    try {
      parsed = parseInboundMessage(message);
    } catch (error: unknown) {
      answerUnparseableUpstream({ message, reason: getErrorMessage(error) });
      return;
    }

    if (Array.isArray(parsed)) {
      warn('upstream_batch', `from upstream: unexpected batch message, ignoring`);
      return;
    }

    if (isSubscriptionMessage(parsed)) {
      logRawUpstreamEvent(parsed);
      handleUpstreamSubscription(parsed);
      return;
    }

    if (isResponseMessage(parsed)) {
      handleUpstreamResponse(parsed);
      return;
    }

    warn('upstream_unrecognized', `from upstream: unrecognized message type`);
  }

  /** Warns of an upstream message that does not parse, and rejects the pending request whose id its raw text holds. */
  function answerUnparseableUpstream({ message, reason }: UnparseableUpstreamParams): void {
    const size = typeof message === 'string' ? message.length : JSON.stringify(message).length;
    warn('upstream_unparseable', `from upstream: unparseable message of ${String(size)} chars (${reason})`);
    if (typeof message !== 'string') {
      return;
    }
    const matchedId = /"id"\s*:\s*("?)([^",}\s]+)\1/.exec(message)?.[2];
    if (matchedId !== undefined && pending.has(matchedId)) {
      handleUpstreamResponse(createJsonRpcError(matchedId, `Upstream returned unparseable response: ${reason}`));
    }
  }

  /** Logs a raw `newBlock` or `initialized` event at debug level, tagged with the sessions that hold its token. */
  function logRawUpstreamEvent(message: SubscriptionMessage): void {
    const result = message.params?.result;
    if (!isRecord(result)) {
      return;
    }
    const event = result['event'];
    const rawSubscription = message.params?.subscription;
    const token = typeof rawSubscription === 'string' ? rawSubscription : '?';
    const owners = ownedTokens.listOwners(token);
    const sessionTag = owners.length > 0 ? owners.map(owned => owned.session.id).join(',') : 'unknown';
    if (event === 'newBlock') {
      logBrokerTraffic(
        `from upstream: raw newBlock [${sessionTag}] hash=${String(result['blockHash']).slice(0, 18)}… parent=${String(result['parentBlockHash']).slice(0, 18)}… token=${token.slice(0, 12)}…`,
      );
    } else if (event === 'initialized') {
      const hashes = result['finalizedBlockHashes'];
      const hashList = Array.isArray(hashes)
        ? readStrings(hashes)
            .map(hash => hash.slice(0, 18) + '…')
            .join(', ')
        : '?';
      logBrokerTraffic(
        `from upstream: raw initialized [${sessionTag}] blocks=[${hashList}] token=${token.slice(0, 12)}…`,
      );
    }
  }

  function handleUpstreamResponse(response: JsonRpcResponse): void {
    const id = String(response.id);
    const owner = pending.take(id);
    if (owner === undefined) {
      warn('response_unknown_id', `from upstream: response for unknown id=${id}`);
      return;
    }
    logBrokerTraffic(
      `Upstream answer for ${owner.kind === 'session' ? owner.session.id : owner.kind}, method=${owner.method} ${describeResponse(response)}`,
    );
    if (owner.method === CHAIN_HEAD_FOLLOW && 'error' in response) {
      reportRefusedFollow(response.error);
    }
    answerOwner(owner, response);
  }

  function answerOwner(owner: RequestOwner, response: JsonRpcResponse): void {
    switch (owner.kind) {
      case 'orphan':
        answerOrphan(owner.method, response);
        return;
      case 'release':
        answerRelease(owner.method, response);
        return;
      case 'session':
        answerSession(owner, response);
        return;
    }
  }

  function answerSession(owner: Extract<RequestOwner, { kind: 'session' }>, response: JsonRpcResponse): void {
    const { session } = owner;
    const answer = { ...response, id: owner.clientId };
    const releaseMethod = TOKEN_METHODS.get(owner.method);
    if (releaseMethod === undefined || typeof response.result !== 'string') {
      sendToSession(session, answer);
      return;
    }
    const upstreamToken = response.result;
    const localToken = ownedTokens.mapToken({ session, upstreamToken, releaseMethod });
    logBrokerTraffic(`Token mapped: ${localToken} to ${upstreamToken} (${owner.method})`);
    sendToSession(session, { ...answer, result: localToken });
    earlySubscriptions.flush(upstreamToken);
  }

  /**
   * The answer to a request no session waits on, as its session left while it was in flight or it was a follow sent
   * without an id. A subscription it opened would run upstream for the broker's life, so it is released at once,
   * unless a session still holds the same upstream subscription.
   */
  function answerOrphan(method: string, response: JsonRpcResponse): void {
    const releaseMethod = TOKEN_METHODS.get(method);
    if (releaseMethod === undefined || typeof response.result !== 'string') {
      logBrokerTraffic(`Dropped the answer to ${method}, which no session waits on`);
      return;
    }
    const upstreamToken = response.result;
    if (ownedTokens.listOwners(upstreamToken).length > 0) {
      return;
    }
    earlySubscriptions.drop(upstreamToken);
    sendRelease({ releaseMethod, upstreamToken });
  }

  /** Nobody waits on a release, so the node refusing one is all there is to tell. */
  function answerRelease(method: string, response: JsonRpcResponse): void {
    if ('error' in response) {
      warn('release_refused', `upstream refused ${method}: ${JSON.stringify(response.error)}`);
    }
  }

  function handleUpstreamSubscription(message: SubscriptionMessage): void {
    const upstreamToken = message.params?.subscription;
    if (typeof upstreamToken !== 'string') {
      warn('subscription_bad_token', `from upstream: subscription with non-string token`);
      return;
    }

    const owners = ownedTokens.listOwners(upstreamToken);
    if (owners.length === 0) {
      // Queued by the node before it read the release, so expected, and nobody will ever map this token again.
      if (pending.isReleasing(upstreamToken)) {
        logBrokerTraffic(`Dropped an event for released subscription ${upstreamToken}`);
        return;
      }
      if (pending.hasSubscriptionRequest()) {
        earlySubscriptions.buffer(upstreamToken, message);
        return;
      }
      warn('subscription_unknown_token', `from upstream: subscription for unknown token: ${upstreamToken}`);
      return;
    }

    const eventResult = message.params?.result;
    const eventType = getEventType(eventResult);

    // Released before anyone hears the final event, as a stopped follow is, so a release sent from inside that
    // delivery is answered locally instead of going upstream for a subscription the node already ended.
    const ends = isRecord(eventResult) && isSubscriptionEnd(message.method, eventResult['event']);
    if (ends) {
      logBrokerTraffic(`Token ended by upstream: ${upstreamToken}`);
      for (const { localToken } of owners) {
        ownedTokens.release(localToken);
      }
    }

    for (const owned of owners) {
      // An earlier delivery can end this session or release its token. A final event still reaches every token it
      // ended.
      if (sessions.get(owned.session.id) !== owned.session || (!ends && !ownedTokens.has(owned.localToken))) {
        continue;
      }
      logBrokerTraffic(`subscription to [${owned.session.id}] event=${eventType} method=${String(message.method)}`);
      sendToSession(owned.session, readdressSubscription(message, owned.localToken));
    }
  }

  function disconnectSession(sessionId: string): void {
    const session = sessions.get(sessionId);
    if (!session) {
      return;
    }
    const owned = ownedTokens.listSessionTokens(session);
    logBrokerTraffic(
      `disconnectSession(${sessionId}) called, pending=${String(pending.count())}, tokens=${String(owned.length)}`,
    );
    sessions.delete(sessionId);

    // An answer still on its way may open a subscription, which nobody would release once its session has gone.
    pending.orphanSession(session);

    // Each token is released even when an earlier release fails upstream, so none stays owned by a gone session.
    runEvery(
      owned.map(token => () => {
        if (ownedTokens.release(token.localToken)) {
          sendRelease(token);
        }
      }),
      `chain broker: releasing what session ${sessionId} held failed`,
    );
  }

  function disconnectUpstream(): void {
    const previous = state;
    // Written first, so a close that throws still leaves the upstream closed. A halt stays final.
    state = previous.kind === 'halted' ? previous : { kind: 'closed' };
    releaseUpstream(previous);
  }

  /** Forgets what the upstream held, then closes it when it was open. Throws what the close throws. */
  function releaseUpstream(previous: UpstreamState): void {
    try {
      pending.clear();
      ownedTokens.clear();
      earlySubscriptions.clear();
    } finally {
      if (previous.kind === 'open') {
        previous.connection.disconnect();
      }
    }
  }

  return {
    /**
     * Opens a session, and the upstream with the first one. Throws when `sessionId` names an open session. The
     * connection it returns routes the session's messages and ends it. On a broker that halted, or that halts or closes
     * while its upstream opens, returns a connection that drops what it sends, adds no session and calls no `onHalt`.
     * The same holds for a `connect` made from inside the provider call that opens the upstream. Throws what the
     * provider throws as the upstream opens, and the next `connect` opens it again.
     */
    connect,
    /**
     * Ends every session, releasing what each holds upstream, then closes the upstream. Every step runs even when one
     * throws, and then the one `Error`, or an AggregateError otherwise, is thrown. A later `connect` reopens the
     * upstream, unless the broker halted.
     */
    disconnectAll,
    /**
     * The transport is gone for good. Each session first gets an error per request in flight and a `stop` per
     * established follow. The upstream is dropped without unsubscribing, as nothing is left to unsubscribe from. A
     * session's throwing handler is reported, never thrown, so every session hears the halt. A later `connect` opens
     * nothing.
     */
    halt,
    /**
     * The follows the node may count on this connection now, as follow tokens sessions hold (each upstream token
     * once), follow requests in flight, and unfollows in flight from a session or the broker. Never throws.
     */
    countFollows,
    /** Whether a session of this broker holds `localToken`. Never throws. */
    hasToken: ownedTokens.has,
  };
}

/** Counts a follow the node refused, telling its follow limit apart from any other refusal. */
function reportRefusedFollow(error: unknown): void {
  const reason = isRecord(error) && error['code'] === FOLLOW_LIMIT_ERROR_CODE ? 'limit' : 'refused';
  report.expected(error, { step: 'chain_follow', metric: chainFollowRefusedMetric, reason });
}
