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
      conn.send(parsed);
    },
    async *responses(): AsyncIterable<string> {
      try {
        while (!stopped) {
          while (queue.length > 0) {
            const response = queue.shift();
            if (response !== undefined) {
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

export function createChainConnect(): HostCallbacks["connect"] {
  return (genesisHashBytes) => {
    const genesisHash = bytesToHex(genesisHashBytes);
    const backend = getBackend();
    if (backend === "rpc-gateway") {
      if (!isRpcChainSupported(genesisHash)) {
        log.warn(
          `[dot.li truapi-chain] RPC backend doesn't support ${genesisHash}; product call will fail`,
        );
        throw new Error(`Unsupported RPC chain: ${genesisHash}`);
      }
      return Promise.resolve(toConnection(createRpcChainProvider(genesisHash)));
    }

    if (!isSmoldotChainSupported(genesisHash)) {
      log.warn(
        `[dot.li truapi-chain] smoldot backend doesn't support ${genesisHash}; product call will fail`,
      );
      throw new Error(`Unsupported smoldot chain: ${genesisHash}`);
    }
    return Promise.resolve(
      toConnection(createSmoldotChainProvider(genesisHash)),
    );
  };
}
