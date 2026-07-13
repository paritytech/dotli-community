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
import type { ChainProvider } from "@parity/truapi-host";
import type { PlatformJsonRpcConnection } from "@parity/truapi-host";
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
} from "./SsoDebug";
import { createStatementStoreDebugObserver } from "./chain-debug";

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
  const debugObserver = createStatementStoreDebugObserver();
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
      debugObserver.observeRequest(parsed);
      conn.send(parsed);
    },
    async *responses(): AsyncIterable<string> {
      try {
        while (!stopped) {
          while (queue.length > 0) {
            const response = queue.shift();
            if (response !== undefined) {
              debugObserver.observeResponse(response);
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

export function createChainConnect(): ChainProvider["connect"] {
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
