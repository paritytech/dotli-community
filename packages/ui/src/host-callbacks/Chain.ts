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

import { bytesToHex } from '@parity/truapi/scale';
import type { JsonRpcConnection, JsonRpcRequest, JsonRpcProvider } from '@polkadot-api/json-rpc-provider';
import type { ChainProvider } from '@parity/truapi-host';
import type { PlatformJsonRpcConnection } from '@parity/truapi-host';
import { getBackend } from '@dotli/config';
import { createChainBrokerManager } from '@dotli/protocol';
import {
  createChainProvider as createSmoldotChainProvider,
  isChainSupported as isSmoldotChainSupported,
  createCoreRpcChainProvider,
  isCoreRpcChainSupported,
} from '@dotli/resolver';

import { log } from '@dotli/shared';
import { ERRORS } from '../errors.js';
import { withTrustedSubmitFallback } from './light-client-submit-fallback.js';

// `createSmoldotChainProvider` returns wrappers around singleton smoldot
// chains. Every wrapper drains the same response queue, so independent core
// connections must share one broker that assigns responses and subscription
// notifications to their owning connection.
const smoldotChainBroker = createChainBrokerManager(createSmoldotChainProvider);

function isJsonRpcRequest(value: unknown): value is JsonRpcRequest<unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const id = record['id'];
  return (
    record['jsonrpc'] === '2.0' &&
    typeof record['method'] === 'string' &&
    (id === undefined || id === null || typeof id === 'string' || typeof id === 'number')
  );
}

function toConnection(
  createProvider: (onHalt: () => void) => JsonRpcProvider<unknown> | null,
): PlatformJsonRpcConnection {
  const queue: string[] = [];
  let wake: (() => void) | null = null;
  const state = { closed: false };
  let conn: JsonRpcConnection<unknown> | null = null;
  const close = (): void => {
    if (state.closed) {
      return;
    }
    state.closed = true;
    queue.length = 0;
    conn?.disconnect();
    wake?.();
    wake = null;
  };
  const provider = createProvider(close);
  if (!provider) {
    throw new Error(ERRORS.CHAIN_PROVIDER_UNAVAILABLE);
  }
  const upstream = provider((message: unknown) => {
    if (state.closed) {
      return;
    }
    queue.push(JSON.stringify(message));
    wake?.();
    wake = null;
  });
  conn = upstream;
  if (state.closed) {
    upstream.disconnect();
  }

  return {
    send(request: string): void {
      if (state.closed) {
        throw new Error('Chain connection is closed');
      }
      const parsed: unknown = JSON.parse(request);
      if (!isJsonRpcRequest(parsed)) {
        throw new Error(ERRORS.INVALID_JSON_RPC_REQUEST);
      }
      upstream.send(parsed);
    },
    async *responses(): AsyncIterable<string> {
      try {
        while (!state.closed) {
          const response = queue.shift();
          if (response !== undefined) {
            yield response;
            continue;
          }
          await new Promise<void>(resolve => {
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

export function createChainConnect(): ChainProvider['connect'] {
  return genesisHashBytes => {
    const genesisHash = bytesToHex(genesisHashBytes);
    const backend = getBackend();
    if (backend === 'rpc-gateway') {
      // This callback is shared by product-forwarded calls and core-owned
      // Bulletin operations. `featureSupported` is the dApp advertisement;
      // this seam cannot enforce that advertised subset.
      if (!isCoreRpcChainSupported(genesisHash)) {
        log.warn(`[dot.li truapi-chain] RPC backend doesn't support ${genesisHash}; product call will fail`);
        throw new Error(`Unsupported RPC chain: ${genesisHash}`);
      }
      const connection = toConnection(onHalt => createCoreRpcChainProvider(genesisHash, onHalt));
      return Promise.resolve(connection);
    }

    if (!isSmoldotChainSupported(genesisHash)) {
      log.warn(`[dot.li truapi-chain] smoldot backend doesn't support ${genesisHash}; product call will fail`);
      throw new Error(`Unsupported smoldot chain: ${genesisHash}`);
    }
    const lightClient = smoldotChainBroker.getLocalProvider(genesisHash);
    // TEMPORARY: see light-client-submit-fallback.ts and ADR 0002.
    return Promise.resolve(
      toConnection(onHalt =>
        lightClient !== null && isCoreRpcChainSupported(genesisHash)
          ? withTrustedSubmitFallback(lightClient, () => createCoreRpcChainProvider(genesisHash, onHalt), genesisHash)
          : lightClient,
      ),
    );
  };
}
