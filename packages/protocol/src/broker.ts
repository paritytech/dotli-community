// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type {
  JsonRpcConnection,
  JsonRpcProvider,
  JsonRpcRequest as UpstreamJsonRpcRequest,
} from "@polkadot-api/json-rpc-provider";

/**
 * String-wire variant of `JsonRpcConnection` exposed by `connectRemote`.
 *
 * The postMessage relay ships `message` as a string, while the upstream
 * `JsonRpcConnection.send` takes `JsonRpcRequest` objects. The local string
 * variant keeps `connectRemote`'s signature matched to the wire.
 */
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

interface PendingRequest {
  sessionId: string;
  clientId: JsonRpcId;
  method: string;
}

interface OwnedToken {
  sessionId: string;
  localToken: string;
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
  finalizedBlockHashes: string[];
  finalizedBlockRuntime: unknown;
  bestBlockHash: string | null;
  blocks: Map<string, CachedBlock>;
}

interface CachedBlock {
  result: Record<string, unknown>;
  parentBlockHash: string | null;
}

type WireMode = "string" | "object";

// Wire mode is fixed at broker construction time. Auto-detecting from
// message shape lets a malformed first payload silently flip the broker
// into the wrong encoding for every subsequent message, so a single
// corrupted request could desync every downstream session. The default is
// "string" because every first-party consumer in this repo emits a JSON
// string (sm-provider `sendJsonRpc`). A future consumer needing the object
// wire should get a constructor flag rather than sniffing, keeping the
// "no silent fallbacks" contract.
const DEFAULT_WIRE_MODE: WireMode = "string";

interface Session {
  id: string;
  onMessage: (message: unknown) => void;
  ownedTokens: Set<string>;
  connected: boolean;
  /** Fixed at session creation, never inferred from message shape later. */
  wireMode: WireMode;
}

/** Internal session handle returned by `ChainBroker.connect()`. */
interface BrokerConnection {
  send: (message: unknown) => void;
  disconnect: () => void;
}

const TOKEN_METHODS = new Map<string, string>([
  ["transaction_v1_broadcast", "transaction_v1_stop"],
  ["statement_subscribeStatement", "statement_unsubscribeStatement"],
]);

function isJsonRpcObject(
  value: unknown,
): value is Record<string, unknown> & { jsonrpc?: string } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function buildJsonRpcError(
  id: JsonRpcId,
  message: string,
): Record<string, unknown> {
  return { jsonrpc: "2.0", id, error: { code: -32603, message } };
}

function buildJsonRpcResult(
  id: JsonRpcId,
  result: unknown,
): Record<string, unknown> {
  return { jsonrpc: "2.0", id, result };
}

function isRequestMessage(value: unknown): value is JsonRpcRequest {
  return isJsonRpcObject(value) && typeof value.method === "string";
}

function isResponseMessage(value: unknown): value is JsonRpcResponse {
  return isJsonRpcObject(value) && "id" in value && !("method" in value);
}

function isSubscriptionMessage(value: unknown): value is SubscriptionMessage {
  return (
    isJsonRpcObject(value) &&
    "method" in value &&
    isJsonRpcObject(value.params) &&
    "subscription" in value.params
  );
}

/**
 * Parse an inbound message into a JS object without guessing wire mode.
 * The sender must match the broker's configured wire mode. Message shape
 * never flips the whole broker's encoding. Strings are parsed for the
 * object wire too, since some substrate clients serialize payloads
 * inconsistently, but the result is always returned as an object.
 */
function parseInbound(message: unknown): unknown {
  if (typeof message === "string") {
    return JSON.parse(message);
  }
  return message;
}

/** Encode a JS object into the given wire format. */
function encode(value: unknown, mode: WireMode): unknown {
  return mode === "string" ? JSON.stringify(value) : value;
}

function cloneWithRewrittenFirstParam(
  request: JsonRpcRequest,
  rewrittenToken: string,
): JsonRpcRequest {
  const params: unknown[] = Array.isArray(request.params)
    ? [...(request.params as unknown[])]
    : [];
  params[0] = rewrittenToken;
  return { ...request, params };
}

export interface ChainBrokerManager {
  connectRemote(
    genesisHash: string,
    connectionId: string,
    onMessage: (message: string) => void,
  ): StringJsonRpcConnection | null;
  getLocalProvider(genesisHash: string): JsonRpcProvider | null;
  disconnectAll(): void;
}

const BROKER_TAG = "[dot.li broker]";
function brokerLog(...args: unknown[]): void {
  console.warn(BROKER_TAG, ...args);
}

class ChainBroker {
  private readonly provider: JsonRpcProvider;
  private readonly onEmpty: () => void;
  private upstream: JsonRpcConnection | null = null;
  private readonly sessions = new Map<string, Session>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly localToOwned = new Map<string, OwnedToken>();
  private readonly upstreamToOwned = new Map<string, OwnedToken>();
  private readonly localFollowTokens = new Map<
    string,
    { sessionId: string; followKey: string }
  >();
  private readonly sharedFollows = new Map<string, SharedFollow>();
  private readonly upstreamFollowTokens = new Map<string, SharedFollow>();
  private requestCounter = 0;
  private tokenCounter = 0;

  constructor(provider: JsonRpcProvider, onEmpty: () => void) {
    this.provider = provider;
    this.onEmpty = onEmpty;
  }

  /** Send a JSON-RPC object to a session in its configured wire format. */
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
  ): BrokerConnection {
    if (this.sessions.has(sessionId)) {
      throw new Error(`Duplicate broker session: ${sessionId}`);
    }

    brokerLog(
      `Session ${sessionId} connecting (${String(this.sessions.size)} existing sessions)`,
    );
    this.ensureUpstream();
    this.sessions.set(sessionId, {
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
    for (const sessionId of [...this.sessions.keys()]) {
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
      `Connecting to upstream provider... (sessions: [${[...this.sessions.keys()].join(",")}])`,
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

    const rewritten = this.rewriteOwnedToken(session, parsed);
    if (rewritten === null) {
      brokerLog(
        `sendFromSession: unknown token for session ${sessionId}, method=${parsed.method as string}`,
      );
      this.sendToSession(
        session,
        buildJsonRpcError(parsed.id ?? null, "Unknown subscription/token"),
      );
      return;
    }

    if (parsed.id === undefined) {
      this.sendUpstream(rewritten);
      return;
    }

    const upstreamId = `broker:${this.requestCounter.toString(36)}:${sessionId}`;
    this.requestCounter += 1;
    this.pending.set(upstreamId, {
      sessionId,
      clientId: parsed.id ?? null,
      method: parsed.method as string,
    });
    this.sendUpstream({ ...rewritten, id: upstreamId });
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

    const followToken = this.localFollowTokens.get(firstParam);
    if (followToken) {
      if (followToken.sessionId !== session.id) {
        return null;
      }
      const sharedFollow = this.sharedFollows.get(followToken.followKey);
      if (
        sharedFollow?.upstreamToken === undefined ||
        sharedFollow.upstreamToken === null
      ) {
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

    const upstreamToken = this.getUpstreamToken(firstParam);
    if (upstreamToken === null) {
      return null;
    }

    return cloneWithRewrittenFirstParam(request, upstreamToken);
  }

  private getUpstreamToken(localToken: string): string | null {
    for (const [upstreamToken, owned] of this.upstreamToOwned.entries()) {
      if (owned.localToken === localToken) {
        return upstreamToken;
      }
    }
    return null;
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
        const owned = this.upstreamToOwned.get(token);
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
      const sharedFollow = this.sharedFollows.get(pending.sessionId);
      if (!sharedFollow) {
        brokerLog(`Missing shared follow state for key ${pending.sessionId}`);
        return;
      }
      sharedFollow.requestInFlight = false;
      sharedFollow.upstreamToken = response.result;
      this.upstreamFollowTokens.set(response.result, sharedFollow);
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
        `← upstream response for disconnected session: sessionId=${JSON.stringify(pending.sessionId)}, method=${pending.method}, responseId=${String(response.id)}, sessions=[${[...this.sessions.keys()].join(",")}]`,
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
      this.localToOwned.set(localToken, owned);
      this.upstreamToOwned.set(response.result, owned);
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

    const sharedFollow = this.upstreamFollowTokens.get(upstreamToken);
    if (sharedFollow) {
      this.cacheSharedFollowEvent(sharedFollow, message.params?.result);
      for (const localToken of sharedFollow.localTokens) {
        const local = this.localFollowTokens.get(localToken);
        if (!local) {
          continue;
        }
        const session = this.sessions.get(local.sessionId);
        if (session?.connected !== true) {
          continue;
        }
        const eventResult = message.params?.result;
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
      return;
    }

    const owned = this.upstreamToOwned.get(upstreamToken);
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

    for (const [localToken, followToken] of [
      ...this.localFollowTokens.entries(),
    ]) {
      if (followToken.sessionId === sessionId) {
        this.releaseLocalFollowToken(localToken);
      }
    }
  }

  private releaseOwnedToken(localToken: string, notifyUpstream: boolean): void {
    const owned = this.localToOwned.get(localToken);
    if (!owned) {
      return;
    }

    this.localToOwned.delete(localToken);
    const session = this.sessions.get(owned.sessionId);
    session?.ownedTokens.delete(localToken);

    let upstreamTokenToDelete: string | null = null;
    for (const [upstreamToken, candidate] of this.upstreamToOwned.entries()) {
      if (candidate.localToken === localToken) {
        upstreamTokenToDelete = upstreamToken;
        break;
      }
    }
    if (upstreamTokenToDelete === null) {
      return;
    }

    this.upstreamToOwned.delete(upstreamTokenToDelete);

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
    this.localToOwned.clear();
    this.upstreamToOwned.clear();
    this.localFollowTokens.clear();
    this.sharedFollows.clear();
    this.upstreamFollowTokens.clear();
    this.upstream?.disconnect();
    this.upstream = null;
  }

  private handleLocalFollowRequest(
    session: Session,
    request: JsonRpcRequest,
  ): void {
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

    const followToken = this.localFollowTokens.get(token);
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
      (pendingLocal) => pendingLocal.localToken !== localToken,
    );
    if (sharedFollow.localTokens.size > 0 || sharedFollow.requestInFlight) {
      return;
    }

    if (sharedFollow.upstreamToken !== null) {
      this.upstreamFollowTokens.delete(sharedFollow.upstreamToken);
      this.sendUpstream({
        jsonrpc: "2.0",
        id: `broker-release:${this.requestCounter.toString(36)}`,
        method: "chainHead_v1_unfollow",
        params: [sharedFollow.upstreamToken],
      });
      this.requestCounter += 1;
    }

    this.sharedFollows.delete(followToken.followKey);
  }

  private cacheSharedFollowEvent(
    sharedFollow: SharedFollow,
    eventResult: unknown,
  ): void {
    if (!isJsonRpcObject(eventResult)) {
      return;
    }

    const eventType =
      typeof eventResult.event === "string" ? eventResult.event : "";
    if (eventType === "initialized") {
      const hashes = Array.isArray(eventResult.finalizedBlockHashes)
        ? eventResult.finalizedBlockHashes.filter(
            (hash): hash is string => typeof hash === "string",
          )
        : [];
      sharedFollow.finalizedBlockHashes = hashes;
      sharedFollow.finalizedBlockRuntime =
        eventResult.finalizedBlockRuntime ?? null;
      sharedFollow.blocks.clear();
      sharedFollow.bestBlockHash = null;
      return;
    }

    if (eventType === "newBlock") {
      const blockHash =
        typeof eventResult.blockHash === "string"
          ? eventResult.blockHash
          : null;
      if (blockHash === null) {
        return;
      }
      sharedFollow.blocks.set(blockHash, {
        result: { ...eventResult },
        parentBlockHash:
          typeof eventResult.parentBlockHash === "string"
            ? eventResult.parentBlockHash
            : null,
      });
      return;
    }

    if (eventType === "bestBlockChanged") {
      sharedFollow.bestBlockHash =
        typeof eventResult.bestBlockHash === "string"
          ? eventResult.bestBlockHash
          : null;
      return;
    }

    if (eventType === "finalized") {
      const hashes = Array.isArray(eventResult.finalizedBlockHashes)
        ? eventResult.finalizedBlockHashes.filter(
            (hash): hash is string => typeof hash === "string",
          )
        : [];
      sharedFollow.finalizedBlockHashes = hashes;
      const pruned = Array.isArray(eventResult.prunedBlockHashes)
        ? eventResult.prunedBlockHashes.filter(
            (hash): hash is string => typeof hash === "string",
          )
        : [];
      for (const hash of pruned) {
        sharedFollow.blocks.delete(hash);
      }
    }
  }

  private replayFollowSnapshot(
    session: Session,
    localToken: string,
    sharedFollow: SharedFollow,
  ): void {
    if (sharedFollow.finalizedBlockHashes.length > 0) {
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
