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
import type { HostCallbacks } from "@parity/truapi-host-wasm";
import type { PlatformJsonRpcConnection } from "@parity/truapi-host-wasm";
import { hasDotliDebugListeners } from "@dotli/truapi-debug/dotli-debug-bus";
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

const STATEMENT_SUBMIT_METHOD = "statement_submit";
const STATEMENT_SUBSCRIBE_METHOD = "statement_subscribeStatement";
const STATEMENT_UNSUBSCRIBE_METHOD = "statement_unsubscribeStatement";

interface StatementStoreDebugRequest {
  method: string;
  requestKind: string;
}

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

function normalizeProviderRequest(
  request: JsonRpcRequest<unknown>,
): JsonRpcRequest<unknown> {
  if (request.method === "chainHead_v1_unpin") {
    const params = Array.isArray(request.params) ? request.params : [];
    if (typeof params[1] === "string") {
      return { ...request, params: [params[0], [params[1]]] };
    }
  }

  if (request.params === undefined) {
    return { ...request, params: [] };
  }

  return request;
}

function toConnection(
  provider: JsonRpcProvider<unknown> | null,
): PlatformJsonRpcConnection {
  if (!provider) {
    throw new Error("Chain provider unavailable");
  }
  const queue: string[] = [];
  const debugRequests = new Map<string, StatementStoreDebugRequest>();
  let wake: (() => void) | null = null;
  let stopped = false;
  let closed = false;
  const conn = provider((message: unknown) => {
    if (closed) {
      return;
    }
    queue.push(JSON.stringify(message));
    wake?.();
    wake = null;
  });
  const close = (): void => {
    if (closed) {
      return;
    }
    stopped = true;
    closed = true;
    conn.disconnect();
    wake?.();
    wake = null;
  };

  return {
    send(request: string): void {
      const parsed: unknown = JSON.parse(request);
      if (!isJsonRpcRequest(parsed)) {
        throw new Error("Invalid JSON-RPC request");
      }
      emitStatementStoreRequest(parsed, debugRequests);
      conn.send(normalizeProviderRequest(parsed));
    },
    async *responses(): AsyncIterable<string> {
      try {
        while (!stopped) {
          while (queue.length > 0) {
            const response = queue.shift();
            if (response !== undefined) {
              emitStatementStoreResponse(response, debugRequests);
              yield response;
            }
          }
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      } finally {
        close();
      }
    },
    close,
  };
}

function emitStatementStoreRequest(
  request: JsonRpcRequest<unknown>,
  debugRequests: Map<string, StatementStoreDebugRequest>,
): void {
  if (!hasDotliDebugListeners()) {
    return;
  }
  const { method, id } = request;
  const requestKind = statementRequestKind(method);
  if (requestKind === null) {
    return;
  }
  if (id === undefined || id === null) {
    return;
  }
  const requestId = String(id);
  debugRequests.set(requestId, { method, requestKind });
  emitSsoStatementStoreRequest({
    method,
    requestId,
    requestKind,
  });
}

function emitStatementStoreResponse(
  response: string,
  debugRequests: Map<string, StatementStoreDebugRequest>,
): void {
  if (!hasDotliDebugListeners()) {
    return;
  }
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
  const responseId = jsonRpcId(record.id);
  if (responseId !== null) {
    const request = debugRequests.get(responseId);
    if (request === undefined) {
      return;
    }
    debugRequests.delete(responseId);
    const error = errorMessage(record.error);
    emitSsoStatementStoreResponse({
      method: request.method,
      requestId: responseId,
      requestKind: request.requestKind,
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

function statementRequestKind(method: string): string | null {
  switch (method) {
    case STATEMENT_SUBMIT_METHOD:
      return "submit";
    case STATEMENT_SUBSCRIBE_METHOD:
      return "subscribe";
    case STATEMENT_UNSUBSCRIBE_METHOD:
      return "unsubscribe";
    default:
      return null;
  }
}

function jsonRpcId(value: unknown): string | null {
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  return null;
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
