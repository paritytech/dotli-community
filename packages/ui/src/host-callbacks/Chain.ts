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
// it reconnects. When a transport dies for good, its connections still
// deliver what was queued (including `dropped` for transaction watches), and
// stay open: the installed truapi-host ignores a stream's end. The next
// request takes a new lease, which rebuilds the chain.

import { bytesToHex } from '@parity/truapi/scale';
import type { JsonRpcConnection, JsonRpcRequest } from '@polkadot-api/json-rpc-provider';
import type { ChainProvider } from '@parity/truapi-host';
import type { PlatformJsonRpcConnection } from '@parity/truapi-host';
import type { JsonRpcProvider } from '@polkadot-api/json-rpc-provider';
import { getActiveServicesConfig, getBackend } from '@dotli/config';
import {
  CHAIN_HALTED_ERROR_DATA,
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
export function createHostChainPool(destroyDelay?: number): ChainPool {
  return createChainPool({
    // Unset, the pool's default: an idle chain is closed after a minute on
    // every backend. A socket is cheap to reopen, and a remote connection is:
    // the frame keeps the light client's chain.
    ...(destroyDelay === undefined ? {} : { destroyDelay }),
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

/** What a request after a halt gets when no new lease can be taken, so it does not hang. */
function haltedAnswer(id: string | number): unknown {
  return {
    jsonrpc: '2.0',
    id,
    error: { code: -32603, message: 'Chain transport halted', data: CHAIN_HALTED_ERROR_DATA },
  };
}

/**
 * A core connection over leases on the host pool. `takeLease` is asked for the
 * first lease, and again on the first send after a halt.
 */
function toConnection(genesisHash: string, takeLease: () => LeaseProvider | null): PlatformJsonRpcConnection {
  const first = takeLease();
  if (!first) {
    throw new Error(ERRORS.CHAIN_PROVIDER_UNAVAILABLE);
  }
  const queue: string[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  let lease: JsonRpcConnection | null = null;

  const deliver = (message: unknown): void => {
    if (closed) {
      return;
    }
    queue.push(JSON.stringify(message));
    wake?.();
    wake = null;
  };
  // A halt drops the lease, and the stream stays open: truapi-host 0.23.0
  // ignores its end and keeps sending on this connection. The broker has
  // answered the requests in flight and stopped the follows, so the next send
  // takes a new lease, which rebuilds the chain (and, after `'frame'`, boots
  // a frame: the product asked).
  const open = (provider: LeaseProvider): JsonRpcConnection => {
    const connection: JsonRpcConnection = provider(deliver, () => {
      if (lease === connection) {
        lease = null;
      }
    });
    lease = connection;
    return connection;
  };
  const reopen = (): JsonRpcConnection | null => {
    try {
      const provider = takeLease();
      if (provider !== null) {
        return open(provider);
      }
    } catch (error: unknown) {
      log.warn(`[dot.li truapi-chain] re-leasing ${genesisHash} failed:`, error);
      return null;
    }
    log.warn(`[dot.li truapi-chain] no chain transport for ${genesisHash} after a halt`);
    return null;
  };
  open(first);

  // A call, so the check after the drain isn't narrowed by earlier ones.
  const isClosed = (): boolean => closed;
  const close = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    lease?.disconnect();
    lease = null;
    wake?.();
    wake = null;
  };

  return {
    send(request: string): void {
      const parsed: unknown = JSON.parse(request);
      if (!isJsonRpcRequest(parsed)) {
        throw new Error(ERRORS.INVALID_JSON_RPC_REQUEST);
      }
      if (closed) {
        return;
      }
      const connection = lease ?? reopen();
      if (connection === null) {
        // Notifications have nothing to answer.
        if (parsed.id !== undefined && parsed.id !== null) {
          deliver(haltedAnswer(parsed.id));
        }
        return;
      }
      connection.send(parsed);
    },
    async *responses(): AsyncIterable<string> {
      try {
        for (;;) {
          while (!isClosed() && queue.length > 0) {
            const response = queue.shift();
            if (response !== undefined) {
              yield response;
            }
          }
          if (isClosed()) {
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
      return Promise.resolve(toConnection(genesisHash, () => pool.getLocalProvider(genesisHash)));
    }

    if (!isRemoteChainConnectable(genesisHash)) {
      log.warn(`[dot.li truapi-chain] smoldot backend doesn't support ${genesisHash}; product call will fail`);
      throw new Error(`Unsupported smoldot chain: ${genesisHash}`);
    }
    return Promise.resolve(toConnection(genesisHash, () => pool.getLocalProvider(genesisHash)));
  };
}
