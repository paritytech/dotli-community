// dot.li — TrUAPI chain callback
//
// Routes product chain RPC traffic through whichever backend the user
// has selected in the host shell ("Light Client", served by the protocol
// frame, or "RPC Node" via curated WSS endpoints).
//
// Without this callback, truapi-server would fall back to its own
// bundled smoldot — which would ignore the toggle and run another light
// client alongside the protocol frame's. On the light client backends the
// host pool reaches each chain over one remote connection to the protocol
// frame, so products share the chains the frame's light client already
// syncs. The host page runs no light client of its own.
//
// Every core connection is a lease on the host page's chain pool: one
// connection per chain, shared through the broker, which keeps each core
// connection's ids apart. Over RPC the socket replays its subscriptions when
// it reconnects. A transport that dies for good ends its connections' streams
// after they deliver what was queued (including `dropped` for transaction
// watches). The installed truapi-host does not act on the end itself, so other
// requests on that connection stay pending (spec follow-up: "Interrupt the
// core on a halt").

import { bytesToHex } from '@parity/truapi/scale';
import type { JsonRpcRequest } from '@polkadot-api/json-rpc-provider';
import type { ChainProvider } from '@parity/truapi-host';
import type { PlatformJsonRpcConnection } from '@parity/truapi-host';
import type { JsonRpcProvider } from '@polkadot-api/json-rpc-provider';
import { getActiveServicesConfig, getBackend } from '@dotli/config';
import {
  createChainPool,
  haltReasonOf,
  isRemoteChainConnectable,
  requireBrokerLocalProvider,
  type ChainPool,
  type LeaseProvider,
  type RemoteChainProvider,
} from '@dotli/protocol';
import { createCoreRpcChainProvider, isCoreRpcChainSupported } from '@dotli/resolver';

import { log } from '@dotli/shared';
import { ERRORS } from '../errors.js';
import { createFrameChainTransport } from './frame-transport.js';

/**
 * The host page's chain pool. A chain's transport follows the backend when
 * its entry is built: the host page's own WebSocket in `rpc-gateway`, a
 * remote connection to the protocol frame otherwise. Every backend switch
 * reloads the page, so an entry never outlives its backend.
 */
export function createHostChainPool(destroyDelay = 60_000): ChainPool {
  return createChainPool({
    // An idle chain is closed after a minute on every backend. A socket is
    // cheap to reopen, and a remote connection is: the frame keeps the
    // light client's chain.
    destroyDelay,
    createTransport: (genesisHash, hooks) =>
      getBackend() === 'rpc-gateway'
        ? createCoreRpcChainProvider(genesisHash, hooks)
        : createFrameChainTransport(genesisHash, hooks),
  });
}

const hostChainPool = createHostChainPool();

/**
 * A new lease on the host pool's Asset Hub connection, shaped for papi's
 * `createClient`. Disconnecting it releases the lease. The rpc-gateway name
 * resolver reads through this instead of dialing its own socket.
 */
export function hostAssetHubProvider(): JsonRpcProvider {
  return requireBrokerLocalProvider(hostChainPool, getActiveServicesConfig().assethub.genesis, 'Asset Hub');
}

/**
 * A papi provider for a host-page chain user (the block bars, the settings
 * probe), or `null` when the active backend cannot serve the chain. Each of
 * its connections is a lease on the host pool, so these users share the
 * products' connection to each chain. A halt reaches them with its reason: a
 * dead protocol frame as `'frame'`, anything else as `'chain'`.
 */
export function hostChainProvider(genesisHash: string, pool: ChainPool = hostChainPool): RemoteChainProvider | null {
  if (!isRemoteChainConnectable(genesisHash)) {
    return null;
  }
  const lease = pool.getLocalProvider(genesisHash);
  if (lease === null) {
    return null;
  }
  return (onMessage, onHalt) =>
    lease(onMessage, error => {
      onHalt?.(haltReasonOf(error));
    });
}

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
  // The chain's transport is gone for good: the stream ends once it has
  // delivered what was queued. truapi-host 0.23.0 ignores the end itself, so
  // other requests on this connection stay pending.
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

    if (!isRemoteChainConnectable(genesisHash)) {
      log.warn(`[dot.li truapi-chain] smoldot backend doesn't support ${genesisHash}; product call will fail`);
      throw new Error(`Unsupported smoldot chain: ${genesisHash}`);
    }
    return Promise.resolve(toConnection(pool.getLocalProvider(genesisHash)));
  };
}
