// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type {
  JsonRpcConnection,
  JsonRpcProvider,
  JsonRpcRequest as UpstreamJsonRpcRequest,
} from "@polkadot-api/json-rpc-provider";
import type {
  BrokerConnection,
  ChainBrokerManager,
  JsonRpcRequest,
  JsonRpcResponse,
  OwnedToken,
  PendingRequest,
  Session,
  SharedFollow,
  SubscriptionMessage,
  WireMode,
} from "./broker-types.ts";
import {
  buildJsonRpcError,
  buildJsonRpcResult,
  cloneWithRewrittenFirstParam,
  isJsonRpcObject,
  isRequestMessage,
  isResponseMessage,
  isSubscriptionMessage,
  normalizeUnpinHashes,
  parseInbound,
} from "./broker-jsonrpc.ts";
import { SessionRegistry } from "./broker-session-registry.ts";
import { TokenRegistry } from "./broker-token-registry.ts";
import { FollowRegistry } from "./broker-follow-registry.ts";

// Re-export the public broker types so existing `@dotli/protocol/broker`
// importers keep resolving after the type/helper split.
export type {
  ChainBrokerManager,
  StringJsonRpcConnection,
} from "./broker-types.ts";

// Wire mode is fixed at broker construction time. Auto-detecting from
// message shape lets a malformed first payload silently flip the broker
// into the wrong encoding for every subsequent message, so a single
// corrupted request could desync every downstream session. The default is
// "string" because every first-party consumer in this repo emits a JSON
// string (sm-provider `sendJsonRpc`). A future consumer needing the object
// wire should get a constructor flag rather than sniffing, keeping the
// "no silent fallbacks" contract.
const DEFAULT_WIRE_MODE: WireMode = "string";

const TOKEN_METHODS = new Map<string, string>([
  ["transaction_v1_broadcast", "transaction_v1_stop"],
  ["statement_subscribeStatement", "statement_unsubscribeStatement"],
]);

// Broker-backed object-wire provider for a chain, or throw. Object-wire (the
// default) matches the polkadot-api getSmProvider boundary the resolver
// expects. Used to route the resolver's Asset Hub reads through the broker's
// shared follow in both the direct and SharedWorker protocol entry points.
export function requireBrokerLocalProvider(
  manager: ChainBrokerManager,
  genesisHash: string,
  label: string,
): JsonRpcProvider {
  const provider = manager.getLocalProvider(genesisHash);
  if (provider === null) {
    throw new Error(`No broker provider available for ${label}`);
  }
  return provider;
}

const BROKER_TAG = "[dot.li broker]";
function brokerLog(...args: unknown[]): void {
  console.warn(BROKER_TAG, ...args);
}

class ChainBroker {
  private readonly provider: JsonRpcProvider;
  private readonly onEmpty: () => void;
  private upstream: JsonRpcConnection | null = null;
  private readonly sessions = new SessionRegistry();
  private readonly tokens = new TokenRegistry();
  private readonly follows = new FollowRegistry();
  private readonly pending = new Map<string, PendingRequest>();
  private requestCounter = 0;
  private tokenCounter = 0;

  constructor(provider: JsonRpcProvider, onEmpty: () => void) {
    this.provider = provider;
    this.onEmpty = onEmpty;
  }

  /** Send a JSON-RPC object to a session in its configured wire format. */
  private sendToSession(session: Session, obj: unknown): void {
    this.sessions.send(session, obj);
  }

  private sendUpstream(obj: unknown): void {
    this.upstream?.send(obj as UpstreamJsonRpcRequest);
  }

  connect(
    sessionId: string,
    onMessage: (message: unknown) => void,
    wireMode: WireMode = DEFAULT_WIRE_MODE,
  ): BrokerConnection {
    if (this.sessions.has(sessionId)) {
      throw new Error(`Duplicate broker session: ${sessionId}`);
    }

    brokerLog(
      `Session ${sessionId} connecting (${String(this.sessions.size)} existing sessions)`,
    );
    this.ensureUpstream();
    this.sessions.add({
      id: sessionId,
      onMessage,
      ownedTokens: new Set<string>(),
      connected: true,
      wireMode,
    });

    return {
      send: (message) => {
        this.sendFromSession(sessionId, message);
      },
      disconnect: () => {
        this.disconnectSession(sessionId);
      },
    };
  }

  disconnectAll(): void {
    for (const sessionId of this.sessions.ids()) {
      this.disconnectSession(sessionId);
    }
    this.disconnectUpstream();
    this.onEmpty();
  }

  private ensureUpstream(): void {
    if (this.upstream !== null) {
      return;
    }
    brokerLog(
      `Connecting to upstream provider... (sessions: [${this.sessions.ids().join(",")}])`,
    );
    this.upstream = this.provider((message) => {
      this.handleUpstreamMessage(message);
    });
    brokerLog(
      `Upstream provider connected (send=${typeof this.upstream.send}, disconnect=${typeof this.upstream.disconnect})`,
    );
  }

  private sendFromSession(sessionId: string, message: unknown): void {
    const session = this.sessions.get(sessionId);
    if (session?.connected !== true) {
      brokerLog(
        `sendFromSession: session ${sessionId} not connected, dropping message`,
      );
      return;
    }

    // Parse the inbound payload against the broker's configured wire
    // mode. Do NOT mutate `session.wireMode` based on the message shape.
    // That would let a malformed first payload permanently flip the
    // encoding for every subsequent message on the session.
    let parsed: unknown;
    try {
      parsed = parseInbound(message);
    } catch {
      brokerLog(`sendFromSession: invalid JSON from session ${sessionId}`);
      this.sendToSession(session, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32603, message: "Invalid JSON-RPC payload" },
      });
      return;
    }

    if (Array.isArray(parsed)) {
      this.sendToSession(
        session,
        buildJsonRpcError(null, "Batch JSON-RPC is unsupported"),
      );
      return;
    }

    if (!isRequestMessage(parsed)) {
      brokerLog(
        `sendFromSession: not a request from session ${sessionId}:`,
        parsed,
      );
      this.sendToSession(
        session,
        buildJsonRpcError(null, "Invalid JSON-RPC request"),
      );
      return;
    }

    brokerLog(
      `→ upstream [${sessionId}] method=${parsed.method as string} id=${String(parsed.id)}`,
    );

    if ((parsed.method as string) === "chainHead_v1_follow") {
      this.handleLocalFollowRequest(session, parsed);
      return;
    }

    if ((parsed.method as string) === "chainHead_v1_unfollow") {
      this.handleLocalUnfollowRequest(session, parsed);
      return;
    }

    if ((parsed.method as string) === "chainHead_v1_unpin") {
      this.handleLocalUnpinRequest(session, parsed);
      return;
    }

    this.routeGenericRequest(session, parsed);
  }

  /** Rewrite a session-owned token to its upstream token and forward. */
  private routeGenericRequest(session: Session, request: JsonRpcRequest): void {
    const rewritten = this.rewriteOwnedToken(session, request);
    if (rewritten === null) {
      brokerLog(
        `routeGenericRequest: unknown token for session ${session.id}, method=${request.method as string}`,
      );
      this.sendToSession(
        session,
        buildJsonRpcError(request.id ?? null, "Unknown subscription/token"),
      );
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
   * Ref-counted `chainHead_v1_unpin`: drop this session's hold on each block
   * and forward the upstream unpin only when no other session still holds it,
   * so sessions sharing one follow can't double-unpin. Replies success (`null`)
   * locally rather than waiting on the upstream.
   */
  private handleLocalUnpinRequest(
    session: Session,
    request: JsonRpcRequest,
  ): void {
    const params = Array.isArray(request.params) ? request.params : [];
    const token = typeof params[0] === "string" ? params[0] : null;
    const followToken =
      token !== null ? this.follows.getLocal(token) : undefined;

    // Non-follow tokens: fall back to the unchanged passthrough.
    if (
      !followToken ||
      token === null ||
      followToken.sessionId !== session.id
    ) {
      this.routeGenericRequest(session, request);
      return;
    }

    const sharedFollow = this.follows.getShared(followToken.followKey);
    if (
      sharedFollow?.upstreamToken === undefined ||
      sharedFollow.upstreamToken === null
    ) {
      this.sendToSession(
        session,
        buildJsonRpcError(request.id ?? null, "Unknown subscription/token"),
      );
      return;
    }

    const orphaned = this.follows.releasePins(
      sharedFollow,
      token,
      normalizeUnpinHashes(params[1]),
    );
    if (orphaned.length > 0) {
      this.sendUpstreamUnpin(sharedFollow.upstreamToken, orphaned);
    }

    if (request.id !== undefined) {
      this.sendToSession(session, buildJsonRpcResult(request.id ?? null, null));
    }
  }

  private sendUpstreamUnpin(upstreamToken: string, hashes: string[]): void {
    this.sendUpstream({
      jsonrpc: "2.0",
      id: `broker-release:${this.requestCounter.toString(36)}`,
      method: "chainHead_v1_unpin",
      params: [upstreamToken, hashes],
    });
    this.requestCounter += 1;
  }

  private rewriteOwnedToken(
    session: Session,
    request: JsonRpcRequest,
  ): JsonRpcRequest | null {
    if (!Array.isArray(request.params) || request.params.length === 0) {
      return request;
    }

    const firstParam: unknown = request.params[0];
    if (typeof firstParam !== "string") {
      return request;
    }

    const followToken = this.follows.getLocal(firstParam);
    if (followToken) {
      if (followToken.sessionId !== session.id) {
        return null;
      }
      const sharedFollow = this.follows.getShared(followToken.followKey);
      if (
        sharedFollow?.upstreamToken === undefined ||
        sharedFollow.upstreamToken === null
      ) {
        return null;
      }
      return cloneWithRewrittenFirstParam(request, sharedFollow.upstreamToken);
    }

    const owned = this.tokens.ownedByLocal(firstParam);
    if (!owned) {
      return request;
    }

    if (owned.sessionId !== session.id) {
      return null;
    }

    const upstreamToken = this.tokens.upstreamForLocal(firstParam);
    if (upstreamToken === null) {
      return null;
    }

    return cloneWithRewrittenFirstParam(request, upstreamToken);
  }

  private handleUpstreamMessage(message: unknown): void {
    // `parseInbound` tolerates both objects (the provider's wire) and
    // strings (some test harnesses feed serialized JSON).
    let parsed: unknown;
    try {
      parsed = parseInbound(message);
    } catch (err: unknown) {
      // An unparseable upstream message must NOT vanish silently. That
      // would leave any pending request waiting for a reply that never
      // arrives. Best-effort recover the JSON-RPC `id` from the raw text
      // so we can reject the matching pending request.
      const reason = err instanceof Error ? err.message : String(err);
      const preview =
        typeof message === "string"
          ? message.slice(0, 200)
          : JSON.stringify(message).slice(0, 200);
      brokerLog(`← upstream: unparseable message: ${preview} (${reason})`);
      if (typeof message === "string") {
        const idMatch = /"id"\s*:\s*("?)([^",}\s]+)\1/.exec(message);
        if (idMatch !== null) {
          const candidates = [idMatch[2]];
          for (const idKey of candidates) {
            const pending = this.pending.get(idKey);
            if (pending !== undefined) {
              this.pending.delete(idKey);
              const session = this.sessions.get(pending.sessionId);
              if (session !== undefined) {
                this.sendToSession(
                  session,
                  buildJsonRpcError(
                    pending.clientId,
                    `Upstream returned unparseable response: ${reason}`,
                  ),
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
      brokerLog(`← upstream: unexpected batch message, ignoring`);
      return;
    }

    // Log raw upstream subscription events with block hashes for debugging
    if (isSubscriptionMessage(parsed)) {
      const result = parsed.params?.result;
      if (isJsonRpcObject(result)) {
        const event = result.event;
        const rawSub = parsed.params?.subscription;
        const token = typeof rawSub === "string" ? rawSub : "?";
        // Find which session owns this token
        const owned = this.tokens.ownedByUpstream(token);
        const sessionTag = owned ? owned.sessionId : "unknown";
        if (event === "newBlock") {
          brokerLog(
            `← raw newBlock [${sessionTag}] hash=${String(result.blockHash).slice(0, 18)}… parent=${String(result.parentBlockHash).slice(0, 18)}… token=${token.slice(0, 12)}…`,
          );
        } else if (event === "initialized") {
          const hashes = result.finalizedBlockHashes;
          const hashList = Array.isArray(hashes)
            ? (hashes as string[]).map((h) => h.slice(0, 18) + "…").join(", ")
            : "?";
          brokerLog(
            `← raw initialized [${sessionTag}] blocks=[${hashList}] token=${token.slice(0, 12)}…`,
          );
        }
      }
      this.handleUpstreamSubscription(parsed);
      return;
    }

    if (isResponseMessage(parsed)) {
      this.handleUpstreamResponse(parsed);
      return;
    }

    brokerLog(
      `← upstream: unrecognized message type:`,
      JSON.stringify(parsed).slice(0, 200),
    );
  }

  private handleUpstreamResponse(response: JsonRpcResponse): void {
    const pending = this.pending.get(String(response.id));
    if (!pending) {
      brokerLog(`← upstream response for unknown id=${String(response.id)}`);
      return;
    }
    this.pending.delete(String(response.id));

    // Log response details, truncating large results.
    const hasError = "error" in response;
    const resultPreview = hasError
      ? `error=${JSON.stringify(response.error)}`
      : typeof response.result === "string" && response.result.length > 200
        ? `result=${response.result.slice(0, 200)}... (${String(response.result.length)} chars)`
        : `result=${JSON.stringify(response.result)}`;
    brokerLog(
      `← upstream [${pending.sessionId}] method=${pending.method} ${resultPreview}`,
    );

    // chainHead_v1_follow responses use the follow key (not a session ID)
    // as pending.sessionId, so handle before the session connectivity check.
    if (
      pending.method === "chainHead_v1_follow" &&
      typeof response.result === "string"
    ) {
      const sharedFollow = this.follows.getShared(pending.sessionId);
      if (!sharedFollow) {
        brokerLog(`Missing shared follow state for key ${pending.sessionId}`);
        return;
      }
      sharedFollow.requestInFlight = false;
      sharedFollow.upstreamToken = response.result;
      this.follows.bindUpstream(response.result, sharedFollow);
      for (const pendingLocal of sharedFollow.pendingLocals.splice(0)) {
        const pendingSession = this.sessions.get(pendingLocal.sessionId);
        if (pendingSession?.connected !== true) {
          continue;
        }
        this.sendToSession(
          pendingSession,
          buildJsonRpcResult(pendingLocal.requestId, pendingLocal.localToken),
        );
      }
      return;
    }

    const session = this.sessions.get(pending.sessionId);
    if (session?.connected !== true) {
      brokerLog(
        `← upstream response for disconnected session: sessionId=${JSON.stringify(pending.sessionId)}, method=${pending.method}, responseId=${String(response.id)}, sessions=[${this.sessions.ids().join(",")}]`,
      );
      return;
    }

    let result: unknown = response.result;
    const releaseMethod = TOKEN_METHODS.get(pending.method);
    if (releaseMethod !== undefined && typeof response.result === "string") {
      const localToken = `token:${this.tokenCounter.toString(36)}:${pending.sessionId}`;
      this.tokenCounter += 1;
      const owned: OwnedToken = {
        sessionId: pending.sessionId,
        localToken,
        releaseMethod,
      };
      this.tokens.link(localToken, response.result, owned);
      session.ownedTokens.add(localToken);
      brokerLog(
        `Token mapped: ${localToken} ↔ ${response.result} (${pending.method})`,
      );
      result = localToken;
    }

    const rewritten: Record<string, unknown> = {
      ...response,
      id: pending.clientId,
    };
    if ("result" in response) {
      rewritten.result = result;
    }
    this.sendToSession(session, rewritten);
  }

  private handleUpstreamSubscription(message: SubscriptionMessage): void {
    const upstreamToken = message.params?.subscription;
    if (typeof upstreamToken !== "string") {
      brokerLog(
        `← upstream subscription with non-string token:`,
        message.params?.subscription,
      );
      return;
    }

    const sharedFollow = this.follows.getByUpstream(upstreamToken);
    if (sharedFollow) {
      this.follows.cacheSharedFollowEvent(sharedFollow, message.params?.result);
      for (const localToken of sharedFollow.localTokens) {
        const local = this.follows.getLocal(localToken);
        if (!local) {
          continue;
        }
        const session = this.sessions.get(local.sessionId);
        if (session?.connected !== true) {
          continue;
        }
        const eventResult = message.params?.result;
        this.follows.registerPinsFromEvent(
          sharedFollow,
          localToken,
          eventResult,
        );
        const eventType = isJsonRpcObject(eventResult)
          ? typeof eventResult.event === "string"
            ? eventResult.event
            : "unknown"
          : "?";
        brokerLog(
          `← subscription [${local.sessionId}] event=${eventType} method=${String(message.method)}`,
        );
        this.sendToSession(session, {
          ...message,
          params: {
            ...message.params,
            subscription: localToken,
          },
        });
      }

      // A `stop` kills this shared follow. Clear its dead upstream token and
      // snapshot so a session's re-follow takes the fresh-follow path instead
      // of binding to the dead token (which reads null and hangs). The `stop`
      // already reached every session above, which papi needs before it
      // re-issues `chainHead_v1_follow`.
      const eventResult = message.params?.result;
      if (isJsonRpcObject(eventResult) && eventResult.event === "stop") {
        brokerLog(
          `Shared follow stopped by upstream; clearing for re-follow: key=${sharedFollow.key} token=${upstreamToken.slice(0, 12)}…`,
        );
        this.follows.unbindUpstream(upstreamToken);
        sharedFollow.upstreamToken = null;
        sharedFollow.requestInFlight = false;
        sharedFollow.finalizedBlockHashes = [];
        sharedFollow.finalizedBlockRuntime = null;
        sharedFollow.bestBlockHash = null;
        sharedFollow.blocks.clear();
      }
      return;
    }

    const owned = this.tokens.ownedByUpstream(upstreamToken);
    if (!owned) {
      brokerLog(`← upstream subscription for unknown token: ${upstreamToken}`);
      return;
    }

    const session = this.sessions.get(owned.sessionId);
    if (session?.connected !== true) {
      brokerLog(
        `← upstream subscription for disconnected session: ${owned.sessionId}`,
      );
      return;
    }

    const eventResult = message.params?.result;
    const eventType = isJsonRpcObject(eventResult)
      ? typeof eventResult.event === "string"
        ? eventResult.event
        : "unknown"
      : "?";
    brokerLog(
      `← subscription [${owned.sessionId}] event=${eventType} method=${String(message.method)}`,
    );

    this.sendToSession(session, {
      ...message,
      params: {
        ...message.params,
        subscription: owned.localToken,
      },
    });

    if (isJsonRpcObject(eventResult) && eventResult.event === "stop") {
      brokerLog(`Token stopped by upstream: ${owned.localToken}`);
      this.releaseOwnedToken(owned.localToken, false);
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
    brokerLog(
      `disconnectSession stack: ${new Error().stack?.split("\n").slice(1, 5).join(" <- ") ?? ""}`,
    );
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

    for (const [localToken, followToken] of this.follows.localEntries()) {
      if (followToken.sessionId === sessionId) {
        this.releaseLocalFollowToken(localToken);
      }
    }
  }

  private releaseOwnedToken(localToken: string, notifyUpstream: boolean): void {
    const owned = this.tokens.ownedByLocal(localToken);
    if (!owned) {
      return;
    }

    const session = this.sessions.get(owned.sessionId);
    session?.ownedTokens.delete(localToken);

    const upstreamTokenToDelete = this.tokens.unlinkByLocal(localToken);
    if (upstreamTokenToDelete === null) {
      return;
    }

    if (!notifyUpstream) {
      return;
    }

    this.sendUpstream({
      jsonrpc: "2.0",
      id: `broker-release:${this.requestCounter.toString(36)}`,
      method: owned.releaseMethod,
      params: [upstreamTokenToDelete],
    });
    this.requestCounter += 1;
  }

  private disconnectUpstream(): void {
    this.pending.clear();
    this.tokens.clear();
    this.follows.clear();
    this.upstream?.disconnect();
    this.upstream = null;
  }

  private handleLocalFollowRequest(
    session: Session,
    request: JsonRpcRequest,
  ): void {
    const followKey = JSON.stringify(request.params ?? []);
    const sharedFollow = this.follows.ensureShared(followKey);

    const localToken = `follow:${this.tokenCounter.toString(36)}:${session.id}`;
    this.tokenCounter += 1;
    this.follows.setLocal(localToken, {
      sessionId: session.id,
      followKey,
    });
    session.ownedTokens.add(localToken);
    sharedFollow.localTokens.add(localToken);

    if (sharedFollow.upstreamToken !== null) {
      if (request.id !== undefined) {
        this.sendToSession(
          session,
          buildJsonRpcResult(request.id ?? null, localToken),
        );
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
      method: "chainHead_v1_follow",
    });
    this.sendUpstream({ ...request, id: upstreamId });
  }

  private handleLocalUnfollowRequest(
    session: Session,
    request: JsonRpcRequest,
  ): void {
    const token =
      Array.isArray(request.params) && typeof request.params[0] === "string"
        ? request.params[0]
        : null;
    if (token === null) {
      this.sendToSession(
        session,
        buildJsonRpcError(request.id ?? null, "Unknown subscription/token"),
      );
      return;
    }

    const followToken = this.follows.getLocal(token);
    if (followToken) {
      if (followToken.sessionId !== session.id) {
        this.sendToSession(
          session,
          buildJsonRpcError(request.id ?? null, "Unknown subscription/token"),
        );
        return;
      }
      this.releaseLocalFollowToken(token);
      if (request.id !== undefined) {
        this.sendToSession(
          session,
          buildJsonRpcResult(request.id ?? null, null),
        );
      }
      return;
    }

    const rewritten = this.rewriteOwnedToken(session, request);
    if (rewritten === null) {
      this.sendToSession(
        session,
        buildJsonRpcError(request.id ?? null, "Unknown subscription/token"),
      );
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

  private releaseLocalFollowToken(localToken: string): void {
    const followToken = this.follows.getLocal(localToken);
    if (!followToken) {
      return;
    }

    this.follows.deleteLocal(localToken);
    const session = this.sessions.get(followToken.sessionId);
    session?.ownedTokens.delete(localToken);

    const sharedFollow = this.follows.getShared(followToken.followKey);
    if (!sharedFollow) {
      return;
    }

    sharedFollow.localTokens.delete(localToken);
    sharedFollow.pendingLocals = sharedFollow.pendingLocals.filter(
      (pendingLocal) => pendingLocal.localToken !== localToken,
    );

    const followStaysAlive =
      sharedFollow.localTokens.size > 0 || sharedFollow.requestInFlight;

    // Drop this token's pins. If the follow stays alive, unpin orphaned blocks
    // upstream; if it's the last token, the unfollow below releases them all.
    const orphaned = this.follows.releasePins(sharedFollow, localToken, null);
    if (followStaysAlive) {
      if (orphaned.length > 0 && sharedFollow.upstreamToken !== null) {
        this.sendUpstreamUnpin(sharedFollow.upstreamToken, orphaned);
      }
      return;
    }

    if (sharedFollow.upstreamToken !== null) {
      this.follows.unbindUpstream(sharedFollow.upstreamToken);
      this.sendUpstream({
        jsonrpc: "2.0",
        id: `broker-release:${this.requestCounter.toString(36)}`,
        method: "chainHead_v1_unfollow",
        params: [sharedFollow.upstreamToken],
      });
      this.requestCounter += 1;
    }

    this.follows.deleteShared(followToken.followKey);
  }

  private replayFollowSnapshot(
    session: Session,
    localToken: string,
    sharedFollow: SharedFollow,
  ): void {
    if (sharedFollow.finalizedBlockHashes.length > 0) {
      for (const hash of sharedFollow.finalizedBlockHashes) {
        this.follows.registerPin(sharedFollow, localToken, hash);
      }
      this.sendToSession(session, {
        jsonrpc: "2.0",
        method: "chainHead_v1_followEvent",
        params: {
          subscription: localToken,
          result: {
            event: "initialized",
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
      if (
        cached.parentBlockHash === null ||
        sharedFollow.finalizedBlockHashes.includes(cached.parentBlockHash)
      ) {
        break;
      }
      cursor = cached.parentBlockHash;
    }

    replayBlocks.reverse();
    for (const result of replayBlocks) {
      this.follows.registerPinsFromEvent(sharedFollow, localToken, result);
      this.sendToSession(session, {
        jsonrpc: "2.0",
        method: "chainHead_v1_followEvent",
        params: {
          subscription: localToken,
          result,
        },
      });
    }

    if (sharedFollow.bestBlockHash !== null) {
      this.sendToSession(session, {
        jsonrpc: "2.0",
        method: "chainHead_v1_followEvent",
        params: {
          subscription: localToken,
          result: {
            event: "bestBlockChanged",
            bestBlockHash: sharedFollow.bestBlockHash,
          },
        },
      });
    }
  }
}

export function createChainBrokerManager(
  createProvider: (genesisHash: string) => JsonRpcProvider | null,
): ChainBrokerManager {
  const brokers = new Map<string, ChainBroker>();
  let localConnectionCounter = 0;

  function getBroker(genesisHash: string): ChainBroker | null {
    let broker = brokers.get(genesisHash);
    if (broker) {
      brokerLog(
        `Reusing existing broker for chain ${genesisHash.slice(0, 10)}…`,
      );
      return broker;
    }

    brokerLog(`Creating new broker for chain ${genesisHash.slice(0, 10)}…`);
    const provider = createProvider(genesisHash);
    if (provider === null) {
      brokerLog(`No provider available for chain ${genesisHash.slice(0, 10)}…`);
      return null;
    }

    broker = new ChainBroker(provider, () => {
      brokerLog(
        `Broker emptied, removing for chain ${genesisHash.slice(0, 10)}…`,
      );
      brokers.delete(genesisHash);
    });
    brokers.set(genesisHash, broker);
    return broker;
  }

  return {
    connectRemote(genesisHash, connectionId, onMessage) {
      const broker = getBroker(genesisHash);
      if (!broker) {
        return null;
      }
      return broker.connect(
        connectionId,
        onMessage as (message: unknown) => void,
        "string",
      );
    },
    getLocalProvider(genesisHash) {
      const broker = getBroker(genesisHash);
      if (!broker) {
        return null;
      }

      return (onMessage) => {
        const connectionId = `local:${localConnectionCounter.toString(36)}`;
        localConnectionCounter += 1;
        return broker.connect(
          connectionId,
          onMessage as (message: unknown) => void,
          "object",
        ) as JsonRpcConnection;
      };
    },
    disconnectAll() {
      for (const broker of brokers.values()) {
        broker.disconnectAll();
      }
      brokers.clear();
    },
  };
}
