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
import { getBackend } from "@dotli/config/mode";
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
  const conn = provider((message: unknown) => {
    queue.push(JSON.stringify(message));
    wake?.();
    wake = null;
  });

  return {
    send(request: string): void {
      const parsed: unknown = JSON.parse(request);
      if (!isJsonRpcRequest(parsed)) {
        throw new Error("Invalid JSON-RPC request");
      }
      emitPairingStatementStoreRequest(parsed);
      conn.send(parsed);
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
    ...(typeof params?.subscription === "string"
      ? { remoteSubscriptionId: params.subscription }
      : {}),
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
    const backend = getBackend();
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
