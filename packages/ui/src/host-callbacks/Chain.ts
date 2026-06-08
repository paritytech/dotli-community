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
  HostCallbacks,
  PlatformJsonRpcConnection,
} from "@parity/truapi-host-wasm";
import type { JsonRpcProvider } from "polkadot-api";
import { getChainBackend } from "@dotli/config/mode";
import {
  createChainProvider as createSmoldotChainProvider,
  isChainSupported as isSmoldotChainSupported,
} from "@dotli/resolver/chains";
import {
  createRpcChainProvider,
  isRpcChainSupported,
} from "@dotli/resolver/rpc-chain";
import { log } from "@dotli/shared/log";

function toConnection(
  provider: JsonRpcProvider | null,
): PlatformJsonRpcConnection {
  if (!provider) throw new Error("Chain provider unavailable");
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
      conn.send(JSON.parse(request));
    },
    async *responses(): AsyncIterable<string> {
      try {
        while (!stopped) {
          while (queue.length > 0) {
            yield queue.shift()!;
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
  return async (genesisHashBytes) => {
    const genesisHash = bytesToHex(genesisHashBytes);
    const backend = getChainBackend();
    if (backend === "rpc") {
      if (!isRpcChainSupported(genesisHash)) {
        log.warn(
          `[dot.li truapi-chain] RPC backend doesn't support ${genesisHash}; product call will fail`,
        );
        throw new Error(`Unsupported RPC chain: ${genesisHash}`);
      }
      return toConnection(createRpcChainProvider(genesisHash));
    }

    if (!isSmoldotChainSupported(genesisHash)) {
      log.warn(
        `[dot.li truapi-chain] smoldot backend doesn't support ${genesisHash}; product call will fail`,
      );
      throw new Error(`Unsupported smoldot chain: ${genesisHash}`);
    }
    return toConnection(createSmoldotChainProvider(genesisHash));
  };
}
