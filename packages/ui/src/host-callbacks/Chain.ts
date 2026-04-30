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

import type { ChainConnect, WasmHostCallbacks } from "@truapi/host-shared";
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

export function createChainConnect(): ChainConnect {
  return (genesisHash, onResponse) => {
    // host-shared transports raw JSON strings; polkadot-api's
    // JsonRpcProvider speaks typed objects. Bridge with parse/stringify
    // at this boundary so the adapter is otherwise a pass-through.
    const onMessage = (message: unknown): void => {
      onResponse(JSON.stringify(message));
    };
    const backend = getChainBackend();
    if (backend === "rpc") {
      if (!isRpcChainSupported(genesisHash)) {
        log.warn(
          `[dot.li truapi-chain] RPC backend doesn't support ${genesisHash}; product call will fail`,
        );
        return null;
      }
      const provider = createRpcChainProvider(genesisHash);
      if (!provider) return null;
      const conn = provider(onMessage);
      return {
        send: (request) => conn.send(JSON.parse(request)),
        close: conn.disconnect,
      };
    }

    if (!isSmoldotChainSupported(genesisHash)) {
      log.warn(
        `[dot.li truapi-chain] smoldot backend doesn't support ${genesisHash}; product call will fail`,
      );
      return null;
    }
    const provider = createSmoldotChainProvider(genesisHash);
    if (!provider) return null;
    const conn = provider(onMessage);
    return {
      send: (request) => conn.send(JSON.parse(request)),
      close: conn.disconnect,
    };
  };
}

export type ChainCallback = NonNullable<WasmHostCallbacks["chainConnect"]>;
