// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type {
  JsonRpcConnection,
  JsonRpcProvider,
  JsonRpcRequest as UpstreamJsonRpcRequest,
} from '@polkadot-api/json-rpc-provider';
import { reportListener } from '@dotli/metrics';
import { combineErrors, getErrorMessage, isRecord } from '@dotli/shared';
import {
  buildJsonRpcResult,
  cloneWithRewrittenFirstParam,
  DEFAULT_WIRE_MODE,
  describeResponse,
  encodeForWire,
  getEventType,
  getOwnerMethod,
  getReleaseResult,
  isRequestMessage,
  isResponseMessage,
  isSubscriptionEnd,
  isSubscriptionMessage,
  normalizeUnpinHashes,
  parseInboundMessage,
  readdressSubscription,
  RELEASE_METHODS,
  TOKEN_METHODS,
  type BrokerConnection,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type OwnedToken,
  type RequestOwner,
  type SendReleaseParams,
  type SessionTokenParams,
  type Session,
  type SubscriptionMessage,
  type WireMode,
} from './brokerMessages.js';
import { createBrokerWarner, logBrokerTraffic, type BrokerWarner } from './createBrokerWarner.js';
import { createChainHaltedError } from './createChainHaltedError.js';
import { createEarlySubscriptions } from './createEarlySubscriptions.js';
import { createJsonRpcError } from './createJsonRpcError.js';
import { createLocalTokenIds } from './createLocalTokenIds.js';
import { createOwnedTokens } from './createOwnedTokens.js';
import { createPendingRequests } from './createPendingRequests.js';
import { createSharedFollows } from './createSharedFollows.js';
import { CHAIN_HEAD_FOLLOW, CHAIN_HEAD_UNFOLLOW, CHAIN_HEAD_UNPIN } from './jsonRpcMethods.js';
import { readStrings } from './readStrings.js';

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
  /** The request as it goes upstream, its tokens already rewritten. */
  request: JsonRpcRequest;
  /** The method the session called, which decides how its answer is mapped. */
  method: string;
  /** The upstream token a release request ends, so events for it in the meantime are dropped quietly. */
  upstreamToken?: string;
};

type UnparseableUpstreamParams = {
  /** The upstream message as it arrived, JSON text or an object. */
  message: unknown;
  /** Why it did not parse. */
  reason: string;
};

// A session's handler that throws on the halt is a defect in its owner, reported while the other sessions still hear it.
const reportHaltListener = reportListener('protocol', 'chain_halt');

/** Builds a broker that serves many JSON-RPC sessions over `provider`, opening it only with the first session. */
export function createChainBroker({ provider, warn = createBrokerWarner() }: Params) {
  let upstream: JsonRpcConnection | null = null;
  const sessions = new Map<string, Session>();
  const localTokenIds = createLocalTokenIds();
  const pending = createPendingRequests({ sendUpstream });
  const earlySubscriptions = createEarlySubscriptions({ warn, deliver: handleUpstreamSubscription });
  const ownedTokens = createOwnedTokens({
    localTokenIds,
    addSessionToken,
    deleteSessionToken,
    sendRelease,
    log: logBrokerTraffic,
  });
  const sharedFollows = createSharedFollows({
    localTokenIds,
    pending,
    earlySubscriptions,
    getSession,
    addSessionToken,
    deleteSessionToken,
    sendToSession,
    sendRelease,
    log: logBrokerTraffic,
  });

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
    sessions.set(sessionId, {
      id: sessionId,
      onMessage,
      ownedTokens: new Set<string>(),
      connected: true,
      wireMode,
      onHalt,
    });

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
    const errors: unknown[] = [];
    for (const sessionId of [...sessions.keys()]) {
      try {
        disconnectSession(sessionId);
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      disconnectUpstream();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length === 0) {
      return;
    }
    throw combineErrors(errors, 'chain broker: closing every session and the upstream failed');
  }

  function halt(error?: unknown): void {
    const haltedSessions = [...sessions.values()];
    sessions.clear();
    for (const session of haltedSessions) {
      // A throwing message handler must not keep its session from hearing the halt.
      try {
        answerHaltedSession(session);
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
    disconnectUpstream();
  }

  function getSession(sessionId: string): Session | undefined {
    return sessions.get(sessionId);
  }

  function addSessionToken({ sessionId, token }: SessionTokenParams): void {
    sessions.get(sessionId)?.ownedTokens.add(token);
  }

  function deleteSessionToken({ sessionId, token }: SessionTokenParams): void {
    sessions.get(sessionId)?.ownedTokens.delete(token);
  }

  function sendToSession(session: Pick<Session, 'onMessage' | 'wireMode'>, message: unknown): void {
    session.onMessage(encodeForWire(message, session.wireMode));
  }

  function sendUpstream(message: unknown): void {
    // The provider types its requests narrower than the messages the broker forwards.
    upstream?.send(message as UpstreamJsonRpcRequest);
  }

  /** Forwards a session's request, owned by the session when it expects an answer. */
  function forwardForSession({ session, request, method, upstreamToken }: ForwardForSessionParams): void {
    if (request.id === undefined) {
      sendUpstream(request);
      return;
    }
    pending.track({
      owner: { kind: 'session', sessionId: session.id, clientId: request.id, method, upstreamToken },
      request,
    });
  }

  /** A release the broker sends itself, for something no session holds anymore. */
  function sendRelease({ method, upstreamToken, params = [] }: SendReleaseParams): void {
    pending.track({
      owner: { kind: 'release', method, upstreamToken },
      request: { jsonrpc: '2.0', method, params: [upstreamToken, ...params] },
    });
  }

  function answerHaltedSession(session: Session): void {
    for (const owner of pending.listOwners()) {
      if (owner.kind === 'session' && owner.sessionId === session.id && owner.clientId !== null) {
        sendToSession(session, createJsonRpcError(owner.clientId, createChainHaltedError()));
      }
    }
    sharedFollows.haltSession(session);
  }

  function ensureUpstream(): void {
    if (upstream !== null) {
      return;
    }
    logBrokerTraffic(`Connecting to upstream provider... (sessions: [${[...sessions.keys()].join(',')}])`);
    upstream = provider(message => {
      handleUpstreamMessage(message);
    });
    logBrokerTraffic(
      `Upstream provider connected (send=${typeof upstream.send}, disconnect=${typeof upstream.disconnect})`,
    );
  }

  function sendFromSession(sessionId: string, message: unknown): void {
    const session = sessions.get(sessionId);
    if (session?.connected !== true) {
      warn('session_not_connected', `sendFromSession: session ${sessionId} not connected, dropping message`);
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

    if (parsed.method === CHAIN_HEAD_FOLLOW) {
      sharedFollows.follow(session, parsed);
      return;
    }

    if (parsed.method === CHAIN_HEAD_UNFOLLOW) {
      handleLocalUnfollowRequest(session, parsed);
      return;
    }

    if (parsed.method === CHAIN_HEAD_UNPIN) {
      handleLocalUnpinRequest(session, parsed);
      return;
    }

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

    forwardForSession({ session, request: rewritten, method });
  }

  function routeOwnedReleaseRequest(session: Session, request: JsonRpcRequest): void {
    const { method } = request;
    const params = Array.isArray(request.params) ? request.params : [];
    const localToken = typeof params[0] === 'string' ? params[0] : null;
    const owned = localToken !== null ? ownedTokens.find(localToken) : undefined;
    if (localToken === null || owned?.sessionId !== session.id || owned.releaseMethod !== method) {
      sendToSession(session, createJsonRpcError(request.id ?? null, 'Unknown subscription/token'));
      return;
    }

    const upstreamToken = owned.upstreamToken;
    const released = ownedTokens.release(localToken, false);
    if (released === null) {
      sendToSession(session, createJsonRpcError(request.id ?? null, 'Unknown subscription/token'));
      return;
    }

    if (!released.lastOwner) {
      if (request.id !== undefined) {
        sendToSession(session, buildJsonRpcResult(request.id ?? null, getReleaseResult(method)));
      }
      return;
    }

    forwardForSession({
      session,
      request: cloneWithRewrittenFirstParam(request, upstreamToken),
      method,
      upstreamToken,
    });
  }

  /** Ref-counted unpin, forwarded only once no session holds the block. Replies success locally at once. */
  function handleLocalUnpinRequest(session: Session, request: JsonRpcRequest): void {
    const params = Array.isArray(request.params) ? request.params : [];
    const token = typeof params[0] === 'string' ? params[0] : null;
    const localFollow = token !== null ? sharedFollows.findLocalFollow(token) : undefined;

    // Not this session's follow token, so it passes through unchanged.
    if (!localFollow || token === null || localFollow.sessionId !== session.id) {
      routeGenericRequest(session, request);
      return;
    }

    const unpinned = sharedFollows.unpin({ localToken: token, hashes: normalizeUnpinHashes(params[1]) });
    if (!unpinned) {
      sendToSession(session, createJsonRpcError(request.id ?? null, 'Unknown subscription/token'));
      return;
    }

    if (request.id !== undefined) {
      sendToSession(session, buildJsonRpcResult(request.id ?? null, null));
    }
  }

  function rewriteOwnedToken(session: Session, request: JsonRpcRequest): JsonRpcRequest | null {
    if (!Array.isArray(request.params) || request.params.length === 0) {
      return request;
    }

    const firstParam: unknown = request.params[0];
    if (typeof firstParam !== 'string') {
      return request;
    }

    const localFollow = sharedFollows.findLocalFollow(firstParam);
    if (localFollow) {
      if (localFollow.sessionId !== session.id || localFollow.upstreamToken === null) {
        return null;
      }
      return cloneWithRewrittenFirstParam(request, localFollow.upstreamToken);
    }

    const owned = ownedTokens.find(firstParam);
    if (!owned) {
      return request;
    }

    if (owned.sessionId !== session.id) {
      return null;
    }

    return cloneWithRewrittenFirstParam(request, owned.upstreamToken);
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
    const ownedLocals = ownedTokens.listLocalTokens(token);
    const sessionTag =
      ownedLocals.length > 0
        ? ownedLocals.map(localToken => ownedTokens.find(localToken)?.sessionId ?? '?').join(',')
        : 'unknown';
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
      `Upstream answer for ${owner.kind === 'session' ? owner.sessionId : owner.kind}, method=${getOwnerMethod(owner)} ${describeResponse(response)}`,
    );
    answerOwner(owner, response);
  }

  function answerOwner(owner: RequestOwner, response: JsonRpcResponse): void {
    switch (owner.kind) {
      case 'follow':
        sharedFollows.answer(owner.follow, response);
        return;
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
    const session = sessions.get(owner.sessionId);
    if (session?.connected !== true) {
      warn(
        'response_disconnected_session',
        `upstream response for disconnected session: sessionId=${JSON.stringify(owner.sessionId)}, method=${owner.method}, responseId=${String(response.id)}`,
      );
      return;
    }
    const releaseMethod = TOKEN_METHODS.get(owner.method);
    const upstreamToken = releaseMethod !== undefined && typeof response.result === 'string' ? response.result : null;
    const rewritten: Record<string, unknown> = { ...response, id: owner.clientId };
    if (upstreamToken !== null && releaseMethod !== undefined) {
      rewritten['result'] = ownedTokens.mapToken({
        sessionId: session.id,
        upstreamToken,
        releaseMethod,
        method: owner.method,
      });
    }
    sendToSession(session, rewritten);
    if (upstreamToken !== null) {
      earlySubscriptions.flush(upstreamToken);
    }
  }

  /**
   * The answer to a request whose session left while it was in flight. A subscription it opened would run upstream
   * for the broker's life, so it is released at once, unless a session still holds the same upstream subscription.
   */
  function answerOrphan(method: string, response: JsonRpcResponse): void {
    const releaseMethod = TOKEN_METHODS.get(method);
    if (releaseMethod === undefined || typeof response.result !== 'string') {
      logBrokerTraffic(`Dropped the answer to ${method} for a session that left`);
      return;
    }
    const upstreamToken = response.result;
    if (ownedTokens.listLocalTokens(upstreamToken).length > 0) {
      return;
    }
    earlySubscriptions.drop(upstreamToken);
    sendRelease({ method: releaseMethod, upstreamToken });
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

    if (sharedFollows.hasUpstreamToken(upstreamToken)) {
      sharedFollows.handleEvent({ upstreamToken, message });
      return;
    }

    const localTokens = ownedTokens.listLocalTokens(upstreamToken);
    if (localTokens.length === 0) {
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
    const recipients: { session: Session; owned: Readonly<OwnedToken> }[] = [];
    for (const localToken of localTokens) {
      const owned = ownedTokens.find(localToken);
      if (owned === undefined) {
        continue;
      }
      const session = sessions.get(owned.sessionId);
      if (session?.connected !== true) {
        warn(
          'subscription_disconnected_session',
          `from upstream: subscription for disconnected session: ${owned.sessionId}`,
        );
        continue;
      }
      recipients.push({ session, owned });
    }

    // Released before anyone hears the final event, as a stopped follow is, so a release sent from inside that
    // delivery is answered locally instead of going upstream for a subscription the node already ended.
    const ends = isRecord(eventResult) && isSubscriptionEnd(message.method, eventResult['event']);
    if (ends) {
      logBrokerTraffic(`Token ended by upstream: ${upstreamToken}`);
      for (const localToken of localTokens) {
        ownedTokens.release(localToken, false);
      }
    }

    for (const { session, owned } of recipients) {
      // An earlier delivery can end this session or release its token. A final event still reaches every token it
      // ended.
      if (!session.connected || (!ends && !ownedTokens.has(owned.localToken))) {
        continue;
      }
      logBrokerTraffic(`subscription to [${owned.sessionId}] event=${eventType} method=${String(message.method)}`);
      sendToSession(session, readdressSubscription(message, owned.localToken));
    }
  }

  function disconnectSession(sessionId: string): void {
    const session = sessions.get(sessionId);
    if (!session) {
      return;
    }
    logBrokerTraffic(
      `disconnectSession(${sessionId}) called, pending=${String(pending.count())}, tokens=${String(session.ownedTokens.size)}`,
    );
    logBrokerTraffic(`disconnectSession stack: ${new Error().stack?.split('\n').slice(1, 5).join(' <- ') ?? ''}`);
    session.connected = false;
    sessions.delete(sessionId);

    // An answer still on its way may open a subscription, which nobody would release once its session has gone.
    pending.orphanSession(sessionId);

    for (const localToken of [...session.ownedTokens]) {
      ownedTokens.release(localToken, true);
    }

    sharedFollows.releaseSession(sessionId);
  }

  function disconnectUpstream(): void {
    const closing = upstream;
    // Dropped first, so a later `connect` opens a fresh upstream even when closing this one throws.
    upstream = null;
    try {
      pending.clear();
      ownedTokens.clear();
      earlySubscriptions.clear();
      sharedFollows.clear();
    } finally {
      closing?.disconnect();
    }
  }

  function handleLocalUnfollowRequest(session: Session, request: JsonRpcRequest): void {
    const token = Array.isArray(request.params) && typeof request.params[0] === 'string' ? request.params[0] : null;
    if (token === null) {
      sendToSession(session, createJsonRpcError(request.id ?? null, 'Unknown subscription/token'));
      return;
    }

    const localFollow = sharedFollows.findLocalFollow(token);
    if (localFollow) {
      if (localFollow.sessionId !== session.id) {
        sendToSession(session, createJsonRpcError(request.id ?? null, 'Unknown subscription/token'));
        return;
      }
      sharedFollows.release(token);
      if (request.id !== undefined) {
        sendToSession(session, buildJsonRpcResult(request.id ?? null, null));
      }
      return;
    }

    const rewritten = rewriteOwnedToken(session, request);
    if (rewritten === null) {
      sendToSession(session, createJsonRpcError(request.id ?? null, 'Unknown subscription/token'));
      return;
    }
    forwardForSession({ session, request: rewritten, method: request.method });
  }

  return {
    /**
     * Opens a session, and the upstream with the first one. Throws when `sessionId` names an open session. The
     * connection it returns routes the session's messages and ends it.
     */
    connect,
    /**
     * Ends every session, releasing what each holds upstream, then closes the upstream. Every step runs even when one
     * throws, and then the one `Error`, or an AggregateError otherwise, is thrown. A later `connect` reopens the
     * upstream.
     */
    disconnectAll,
    /**
     * The transport is gone for good. Each session first gets an error per request in flight and a `stop` per
     * established follow. The upstream is dropped without unsubscribing, as nothing is left to unsubscribe from. A
     * session's throwing handler is reported, never thrown, so every session hears the halt.
     */
    halt,
  };
}
