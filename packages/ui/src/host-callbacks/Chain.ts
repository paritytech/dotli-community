// dot.li — TrUAPI chain callback
//
// Routes product chain RPC traffic through whichever backend the user
// has selected in the host shell ("Light Client" via smoldot, or
// "RPC Node" via curated WSS endpoints).
//
// Without this callback, truapi-server would fall back to its own
// bundled smoldot — which would ignore the toggle, double the
// light-client footprint, and rebuild a fresh chain alongside the one
// dotli's resolver already maintains. Routing through dotli's existing
// providers reuses already-synced chains and respects the toggle.

import { bytesToHex } from "@parity/truapi/scale";
import type {
  JsonRpcRequest,
  JsonRpcProvider,
} from "@polkadot-api/json-rpc-provider";
import type {
  HostCallbacks,
  PlatformJsonRpcConnection,
} from "@parity/truapi-host-wasm";
import { SS_USE_SMOLDOT } from "@dotli/config/config";
import { getBackend } from "@dotli/config/mode";
import { getActiveServicesConfig } from "@dotli/config/network";
import {
  createChainProvider as createSmoldotChainProvider,
  isChainSupported as isSmoldotChainSupported,
} from "@dotli/resolver/chains";
import {
  createRpcChainProvider,
  isRpcChainSupported,
} from "@dotli/resolver/rpc-chain";
import { log } from "@dotli/shared/log";
import {
  emitSsoStatementStoreConnected,
  emitSsoStatementStoreConnecting,
  emitSsoStatementStoreConnectFailed,
  emitSsoStatementStoreRequest,
  emitSsoStatementStoreResponse,
} from "./SsoDebug";

const PAIRING_REQUEST_ID_PREFIX = "truapi:sso-pairing:";
const PAIRING_LIVE_REQUEST_ID = "truapi:sso-pairing:1";
const STATEMENT_SUBSCRIBE_METHOD = "statement_subscribeStatement";
const STATEMENT_UNSUBSCRIBE_METHOD = "statement_unsubscribeStatement";

function isJsonRpcRequest(value: unknown): value is JsonRpcRequest<unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const id = record.id;
  return (
    record.jsonrpc === "2.0" &&
    typeof record.method === "string" &&
    (id === undefined ||
      id === null ||
      typeof id === "string" ||
      typeof id === "number")
  );
}

function toConnection(
  provider: JsonRpcProvider<unknown> | null,
): PlatformJsonRpcConnection {
  if (!provider) {
    throw new Error("Chain provider unavailable");
  }
  const queue: string[] = [];
  let wake: (() => void) | null = null;
  let stopped = false;
  let hostQueryTimer: ReturnType<typeof setInterval> | null = null;
  let hostQueryCounter = 0;
  let pairingLiveRemoteId: string | null = null;
  const hostQueryRemoteIds = new Map<string, string>();
  const hostQueryCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const hostQueryUnsubscribeIds = new Set<string>();
  const conn = provider((message: unknown) => {
    handleProviderMessage(message);
  });

  const stopHostPairingQueries = (): void => {
    if (hostQueryTimer !== null) {
      clearInterval(hostQueryTimer);
      hostQueryTimer = null;
    }
    for (const timer of hostQueryCleanupTimers.values()) {
      clearTimeout(timer);
    }
    hostQueryCleanupTimers.clear();
    hostQueryRemoteIds.clear();
    hostQueryUnsubscribeIds.clear();
  };

  const enqueueResponse = (message: unknown): void => {
    queue.push(JSON.stringify(message));
    wake?.();
    wake = null;
  };

  const unsubscribeHostQuery = (
    requestId: string,
    remoteSubscriptionId: string,
  ): void => {
    const unsubscribeId = `${requestId}:unsubscribe`;
    if (hostQueryUnsubscribeIds.has(unsubscribeId)) {
      return;
    }
    hostQueryUnsubscribeIds.add(unsubscribeId);
    conn.send({
      jsonrpc: "2.0",
      id: unsubscribeId,
      method: STATEMENT_UNSUBSCRIBE_METHOD,
      params: [remoteSubscriptionId],
    });
  };

  const handleHostQueryAck = (
    requestId: string,
    remoteSubscriptionId: string,
  ): void => {
    hostQueryRemoteIds.set(remoteSubscriptionId, requestId);
    const timer = setTimeout(() => {
      hostQueryCleanupTimers.delete(remoteSubscriptionId);
      hostQueryRemoteIds.delete(remoteSubscriptionId);
      unsubscribeHostQuery(requestId, remoteSubscriptionId);
    }, 5_000);
    hostQueryCleanupTimers.set(remoteSubscriptionId, timer);
  };

  const handleHostQueryPage = (
    message: Record<string, unknown>,
    remoteSubscriptionId: string,
  ): void => {
    const requestId = hostQueryRemoteIds.get(remoteSubscriptionId);
    if (!requestId) {
      return;
    }
    const params =
      typeof message.params === "object" && message.params !== null
        ? (message.params as Record<string, unknown>)
        : null;
    const result =
      typeof params?.result === "object" && params.result !== null
        ? (params.result as Record<string, unknown>)
        : null;
    const data =
      typeof result?.data === "object" && result.data !== null
        ? (result.data as Record<string, unknown>)
        : null;
    const statements = Array.isArray(data?.statements) ? data.statements : [];
    if (statements.length > 0 && pairingLiveRemoteId !== null) {
      enqueueResponse({
        ...message,
        params: {
          ...params,
          subscription: pairingLiveRemoteId,
        },
      });
    }
    if (result?.event === "newStatements" && data?.remaining === 0) {
      const timer = hostQueryCleanupTimers.get(remoteSubscriptionId);
      if (timer !== undefined) {
        clearTimeout(timer);
        hostQueryCleanupTimers.delete(remoteSubscriptionId);
      }
      hostQueryRemoteIds.delete(remoteSubscriptionId);
      unsubscribeHostQuery(requestId, remoteSubscriptionId);
    }
  };

  const handleProviderMessage = (message: unknown): void => {
    if (typeof message !== "object" || message === null) {
      enqueueResponse(message);
      return;
    }
    const rawResponse = JSON.stringify(message);
    const record = message as Record<string, unknown>;
    if (record.id === PAIRING_LIVE_REQUEST_ID && typeof record.result === "string") {
      pairingLiveRemoteId = record.result;
      enqueueResponse(message);
      return;
    }
    if (
      typeof record.id === "string" &&
      record.id.startsWith(`${PAIRING_LIVE_REQUEST_ID}:query:host:`)
    ) {
      if (typeof record.result === "string") {
        handleHostQueryAck(record.id, record.result);
      }
      emitPairingStatementStoreResponse(rawResponse);
      return;
    }
    if (
      typeof record.id === "string" &&
      hostQueryUnsubscribeIds.has(record.id)
    ) {
      hostQueryUnsubscribeIds.delete(record.id);
      emitPairingStatementStoreResponse(rawResponse);
      return;
    }
    const params =
      typeof record.params === "object" && record.params !== null
        ? (record.params as Record<string, unknown>)
        : null;
    const remoteSubscriptionId =
      typeof params?.subscription === "string" ? params.subscription : null;
    if (remoteSubscriptionId !== null && hostQueryRemoteIds.has(remoteSubscriptionId)) {
      emitPairingStatementStoreResponse(rawResponse);
      handleHostQueryPage(record, remoteSubscriptionId);
      return;
    }
    enqueueResponse(message);
  };

  const startHostPairingQueries = (request: JsonRpcRequest<unknown>): void => {
    if (
      request.method !== STATEMENT_SUBSCRIBE_METHOD ||
      request.id !== PAIRING_LIVE_REQUEST_ID
    ) {
      return;
    }
    stopHostPairingQueries();
    const params = request.params;
    hostQueryTimer = setInterval(() => {
      if (stopped) {
        stopHostPairingQueries();
        return;
      }
      hostQueryCounter += 1;
      const query: JsonRpcRequest<unknown> = {
        jsonrpc: "2.0",
        id: `${PAIRING_LIVE_REQUEST_ID}:query:host:${String(hostQueryCounter)}`,
        method: STATEMENT_SUBSCRIBE_METHOD,
        params,
      };
      emitPairingStatementStoreRequest(query);
      conn.send(query);
    }, 2_000);
  };

  return {
    send(request: string): void {
      const parsed: unknown = JSON.parse(request);
      if (!isJsonRpcRequest(parsed)) {
        throw new Error("Invalid JSON-RPC request");
      }
      emitPairingStatementStoreRequest(parsed);
      conn.send(parsed);
      startHostPairingQueries(parsed);
      if (
        parsed.method === STATEMENT_UNSUBSCRIBE_METHOD &&
        typeof parsed.id === "string" &&
        parsed.id.startsWith(PAIRING_REQUEST_ID_PREFIX)
      ) {
        stopHostPairingQueries();
      }
    },
    async *responses(): AsyncIterable<string> {
      try {
        while (!stopped) {
          while (queue.length > 0) {
            const response = queue.shift();
            if (response !== undefined) {
              emitPairingStatementStoreResponse(response);
              yield response;
            }
          }
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      } finally {
        stopped = true;
        stopHostPairingQueries();
        conn.disconnect();
      }
    },
  };
}

function emitPairingStatementStoreRequest(request: JsonRpcRequest<unknown>) {
  const { method, id } = request;
  if (
    method !== STATEMENT_SUBSCRIBE_METHOD &&
    method !== STATEMENT_UNSUBSCRIBE_METHOD
  ) {
    return;
  }
  if (typeof id !== "string" || !id.startsWith(PAIRING_REQUEST_ID_PREFIX)) {
    return;
  }
  emitSsoStatementStoreRequest({
    method,
    requestId: id,
    requestKind: requestKindFromId(id, method),
  });
}

function emitPairingStatementStoreResponse(response: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(response);
  } catch {
    return;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return;
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.id === "string") {
    if (!record.id.startsWith(PAIRING_REQUEST_ID_PREFIX)) {
      return;
    }
    const error = errorMessage(record.error);
    emitSsoStatementStoreResponse({
      method: statementMethodFromRequestId(record.id),
      requestId: record.id,
      requestKind: requestKindFromId(record.id),
      frameKind: error === undefined ? "ack" : "error",
      ...(typeof record.result === "string"
        ? { remoteSubscriptionId: record.result }
        : {}),
      ...(error !== undefined ? { error } : {}),
    });
    return;
  }

  if (record.method !== STATEMENT_SUBSCRIBE_METHOD) {
    return;
  }
  const params =
    typeof record.params === "object" && record.params !== null
      ? (record.params as Record<string, unknown>)
      : null;
  const result =
    typeof params?.result === "object" && params.result !== null
      ? (params.result as Record<string, unknown>)
      : null;
  const data =
    typeof result?.data === "object" && result.data !== null
      ? (result.data as Record<string, unknown>)
      : null;
  const statements = Array.isArray(data?.statements) ? data.statements : [];
  emitSsoStatementStoreResponse({
    method: STATEMENT_SUBSCRIBE_METHOD,
    requestKind: "page",
    frameKind: result === null ? "malformed-page" : "page",
    ...(typeof params?.subscription === "string"
      ? { remoteSubscriptionId: params.subscription }
      : {}),
    ...(typeof result?.event === "string" ? { eventName: result.event } : {}),
    statementCount: statements.length,
    ...(typeof data?.remaining === "number"
      ? { remaining: data.remaining }
      : {}),
  });
}

function requestKindFromId(requestId: string, method?: string): string {
  if (requestId.includes(":query:")) {
    return "query";
  }
  if (requestId.endsWith(":unsubscribe")) {
    return "unsubscribe";
  }
  if (method === STATEMENT_UNSUBSCRIBE_METHOD) {
    return "unsubscribe";
  }
  return "live-subscribe";
}

function statementMethodFromRequestId(requestId: string): string {
  return requestId.endsWith(":unsubscribe")
    ? STATEMENT_UNSUBSCRIBE_METHOD
    : STATEMENT_SUBSCRIBE_METHOD;
}

function errorMessage(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const message = (error as Record<string, unknown>).message;
  return typeof message === "string" ? message : JSON.stringify(error);
}

export function createChainConnect(): HostCallbacks["connect"] {
  return (genesisHashBytes) => {
    const genesisHash = bytesToHex(genesisHashBytes);
    const backend = backendForChain(genesisHash);
    emitSsoStatementStoreConnecting({ backend, genesisHash });
    if (backend === "rpc-gateway") {
      if (!isRpcChainSupported(genesisHash)) {
        log.warn(
          `[dot.li truapi-chain] RPC backend doesn't support ${genesisHash}; product call will fail`,
        );
        emitSsoStatementStoreConnectFailed({
          backend,
          genesisHash,
          reason: `Unsupported RPC chain: ${genesisHash}`,
        });
        throw new Error(`Unsupported RPC chain: ${genesisHash}`);
      }
      const connection = toConnection(createRpcChainProvider(genesisHash));
      emitSsoStatementStoreConnected({ backend, genesisHash });
      return Promise.resolve(connection);
    }

    if (!isSmoldotChainSupported(genesisHash)) {
      log.warn(
        `[dot.li truapi-chain] smoldot backend doesn't support ${genesisHash}; product call will fail`,
      );
      emitSsoStatementStoreConnectFailed({
        backend,
        genesisHash,
        reason: `Unsupported smoldot chain: ${genesisHash}`,
      });
      throw new Error(`Unsupported smoldot chain: ${genesisHash}`);
    }
    try {
      const connection = toConnection(createSmoldotChainProvider(genesisHash));
      emitSsoStatementStoreConnected({ backend, genesisHash });
      return Promise.resolve(connection);
    } catch (error) {
      emitSsoStatementStoreConnectFailed({
        backend,
        genesisHash,
        reason: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };
}

function backendForChain(genesisHash: string): ReturnType<typeof getBackend> {
  const backend = getBackend();
  const peopleGenesis = getActiveServicesConfig().people.genesis.toLowerCase();
  if (
    !SS_USE_SMOLDOT &&
    genesisHash.toLowerCase() === peopleGenesis &&
    isRpcChainSupported(genesisHash)
  ) {
    return "rpc-gateway";
  }
  return backend;
}
