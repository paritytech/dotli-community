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
//
// Every core connection is a lease on the host page's chain pool: one
// connection per chain, shared through the broker, which keeps each core
// connection's ids apart. Over RPC the socket replays its subscriptions when
// it reconnects. A transport that dies for good ends its connections' streams
// after they deliver what was queued (including `dropped` for transaction
// watches). The broker answers pending calls before the stream ends; later
// sends on that retired lease are rejected rather than silently discarded.
// Native boundary limitation: the pinned worker adapter logs send failures and
// ignores iterator completion instead of interrupting the core connection.
// Requests issued by that core after retirement still need native interruption.

import { bytesToHex } from '@parity/truapi/scale';
import type { JsonRpcRequest } from '@polkadot-api/json-rpc-provider';
import type { ChainProvider } from '@parity/truapi-host';
import type { PlatformJsonRpcConnection } from '@parity/truapi-host';
import { getBackend } from '@dotli/config';
import { createChainPool, type ChainPool, type LeaseProvider } from '@dotli/protocol';
import {
  createChainProvider as createSmoldotChainProvider,
  isChainSupported as isSmoldotChainSupported,
  createCoreRpcChainProvider,
  isCoreRpcChainSupported,
} from '@dotli/resolver';

import { log } from '@dotli/shared';
import { ERRORS } from '../errors.js';
import { withTrustedSubmitFallback } from './light-client-submit-fallback.js';

// The temporary submit fallback is deliberately independent of the selected
// light-client transport. Its RPC leases still use the shared replay/watch policy.
const trustedSubmitPool = createChainPool({
  createTransport: createCoreRpcChainProvider,
  destroyDelay: 0,
});

/**
 * The host page's chain pool. A chain's transport follows the backend when
 * its entry is built: a WebSocket in `rpc-gateway`, smoldot otherwise. Every
 * backend switch reloads the page, so an entry never outlives its backend.
 */
export function createHostChainPool(destroyDelay?: number): ChainPool {
  return createChainPool({
    // truapi-provider drops a smoldot chain once nothing holds it, so closing
    // one after an idle delay would only make the next connect re-add and
    // re-sync a chain main keeps open for good. Read when the countdown starts
    // (after boot), not at import.
    destroyDelay: destroyDelay ?? (() => (getBackend() === 'rpc-gateway' ? 60_000 : Infinity)),
    createTransport: (genesisHash, hooks) => {
      if (getBackend() === 'rpc-gateway') {
        return createCoreRpcChainProvider(genesisHash, hooks);
      }
      const lightClient = createSmoldotChainProvider(genesisHash, hooks);
      return lightClient === null
        ? null
        : withTrustedSubmitFallback(lightClient, () => trustedSubmitPool.getLocalProvider(genesisHash), genesisHash);
    },
  });
}

const hostChainPool = createHostChainPool();

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

function toConnection(provider: LeaseProvider | null): PlatformJsonRpcConnection {
  if (!provider) {
    throw new Error(ERRORS.CHAIN_PROVIDER_UNAVAILABLE);
  }
  const queue: string[] = [];
  let wake: (() => void) | null = null;
  let halted = false;
  let closed = false;
  // Deliver terminal responses before ending the stream. Native consumers need
  // these responses even when their adapter does not act on iterator completion.
  const halt = (): void => {
    halted = true;
    wake?.();
    wake = null;
  };
  const conn = provider((message: unknown) => {
    if (closed) {
      return;
    }
    queue.push(JSON.stringify(message));
    wake?.();
    wake = null;
  }, halt);
  // Calls, so the checks after the drain aren't narrowed by earlier ones.
  const isHalted = (): boolean => halted;
  const isClosed = (): boolean => closed;
  const close = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    conn.disconnect();
    wake?.();
    wake = null;
  };

  return {
    send(request: string): void {
      if (closed || halted) {
        throw new Error(ERRORS.CHAIN_PROVIDER_UNAVAILABLE);
      }
      const parsed: unknown = JSON.parse(request);
      if (!isJsonRpcRequest(parsed)) {
        throw new Error(ERRORS.INVALID_JSON_RPC_REQUEST);
      }
      conn.send(parsed);
    },
    async *responses(): AsyncIterable<string> {
      try {
        for (;;) {
          // A halt still delivers what was queued; a close ends at once.
          while (!isClosed() && queue.length > 0) {
            const response = queue.shift();
            if (response !== undefined) {
              yield response;
            }
          }
          if (isHalted() || isClosed()) {
            break;
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

export function createChainConnect(pool: ChainPool = hostChainPool): ChainProvider['connect'] {
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
      return Promise.resolve(toConnection(pool.getLocalProvider(genesisHash)));
    }

    if (!isSmoldotChainSupported(genesisHash)) {
      log.warn(`[dot.li truapi-chain] smoldot backend doesn't support ${genesisHash}; product call will fail`);
      throw new Error(`Unsupported smoldot chain: ${genesisHash}`);
    }
    return Promise.resolve(toConnection(pool.getLocalProvider(genesisHash)));
  };
}
