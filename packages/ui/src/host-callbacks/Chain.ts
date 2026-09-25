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
import type { ChainProvider, HopProvider } from "@parity/truapi-host";
import type { PlatformJsonRpcConnection } from "@parity/truapi-host";
import { getBackend } from "@dotli/config/mode";
import { getActiveServicesConfig } from "@dotli/config/network";
import { createChainBrokerManager } from "@dotli/protocol/broker";
import {
  createChainProvider as createSmoldotChainProvider,
  isChainSupported as isSmoldotChainSupported,
} from "@dotli/resolver/provider";
import {
  createCoreRpcChainProvider,
  isCoreRpcChainSupported,
} from "@dotli/resolver/rpc-chain";
import { log } from "@dotli/shared/log";
import { ERRORS } from "../errors";
import { withTrustedSubmitFallback } from "./light-client-submit-fallback";

// `createSmoldotChainProvider` returns wrappers around singleton smoldot
// chains. Every wrapper drains the same response queue, so independent core
// connections must share one broker that assigns responses and subscription
// notifications to their owning connection.
const smoldotChainBroker = createChainBrokerManager(createSmoldotChainProvider);

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
    throw new Error(ERRORS.CHAIN_PROVIDER_UNAVAILABLE);
  }
  const queue: string[] = [];
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
        throw new Error(ERRORS.INVALID_JSON_RPC_REQUEST);
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
        close();
      }
    },
    close,
  };
}

export function createChainConnect(): ChainProvider["connect"] {
  return (genesisHashBytes) => {
    const genesisHash = bytesToHex(genesisHashBytes);
    const backend = getBackend();
    if (backend === "rpc-gateway") {
      // This callback is shared by product-forwarded calls and core-owned
      // Bulletin operations. `featureSupported` is the dApp advertisement;
      // this seam cannot enforce that advertised subset.
      if (!isCoreRpcChainSupported(genesisHash)) {
        log.warn(
          `[dot.li truapi-chain] RPC backend doesn't support ${genesisHash}; product call will fail`,
        );
        throw new Error(`Unsupported RPC chain: ${genesisHash}`);
      }
      const connection = toConnection(createCoreRpcChainProvider(genesisHash));
      return Promise.resolve(connection);
    }

    if (!isSmoldotChainSupported(genesisHash)) {
      log.warn(
        `[dot.li truapi-chain] smoldot backend doesn't support ${genesisHash}; product call will fail`,
      );
      throw new Error(`Unsupported smoldot chain: ${genesisHash}`);
    }
    const lightClient = smoldotChainBroker.getLocalProvider(genesisHash);
    // TEMPORARY: see light-client-submit-fallback.ts and ADR 0002.
    return Promise.resolve(
      toConnection(
        lightClient !== null && isCoreRpcChainSupported(genesisHash)
          ? withTrustedSubmitFallback(
              lightClient,
              () => createCoreRpcChainProvider(genesisHash),
              genesisHash,
            )
          : lightClient,
      ),
    );
  };
}

/** HOP is a separate trusted transport, not a fallback chain RPC provider. */
export function createHopProvider(): Required<HopProvider> {
  return {
    allowedHopEndpoints(genesisHash) {
      const bulletin = getActiveServicesConfig().bulletin;
      return Promise.resolve(
        bytesToHex(genesisHash) === bulletin.genesis.toLowerCase()
          ? [...(bulletin.hopEndpoints ?? [])]
          : [],
      );
    },
    async connectHop(genesisHash, endpoint) {
      const bulletin = getActiveServicesConfig().bulletin;
      if (
        bytesToHex(genesisHash) !== bulletin.genesis.toLowerCase() ||
        bulletin.hopEndpoints?.includes(endpoint) !== true
      ) {
        throw new Error(
          "HOP endpoint is not configured for this Bulletin chain",
        );
      }
      const socket = new WebSocket(endpoint);
      const opened = Promise.withResolvers<undefined>();
      const queue: string[] = [];
      let stopped = false;
      let wake: (() => void) | undefined;
      const close = (): void => {
        if (stopped) {
          return;
        }
        stopped = true;
        socket.close();
        opened.reject(new Error("HOP connection closed before opening"));
        wake?.();
      };
      socket.onopen = () => {
        opened.resolve(undefined);
      };
      socket.onerror = close;
      socket.onclose = close;
      socket.onmessage = (event: MessageEvent<unknown>) => {
        if (stopped) {
          return;
        }
        if (typeof event.data !== "string") {
          close();
          return;
        }
        queue.push(event.data);
        wake?.();
        wake = undefined;
      };
      await opened.promise;
      return {
        send(request) {
          if (stopped || socket.readyState !== WebSocket.OPEN) {
            throw new Error("HOP connection is closed");
          }
          socket.send(request);
        },
        async *responses() {
          try {
            while (!stopped) {
              const response = queue.shift();
              if (response !== undefined) {
                yield response;
                continue;
              }
              const next = Promise.withResolvers<undefined>();
              wake = () => {
                next.resolve(undefined);
              };
              await next.promise;
            }
          } finally {
            close();
          }
        },
        close,
      };
    },
  };
}
