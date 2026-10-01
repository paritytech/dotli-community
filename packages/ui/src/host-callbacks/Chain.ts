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
// request takes a new lease, which rebuilds the chain, through a backoff.

import { bytesToHex } from '@parity/truapi/scale';
import type { JsonRpcConnection, JsonRpcRequest } from '@polkadot-api/json-rpc-provider';
import type { ChainProvider } from '@parity/truapi-host';
import type { PlatformJsonRpcConnection } from '@parity/truapi-host';
import type { JsonRpcProvider } from '@polkadot-api/json-rpc-provider';
import { getActiveServicesConfig, getBackend } from '@dotli/config';
import {
  chainHaltedError,
  createChainPool,
  haltReasonOf,
  isProtocolBooting,
  isProtocolReady,
  isRemoteChainConnectable,
  onProtocolReady,
  requireBrokerLocalProvider,
  type ChainPool,
  type LeaseProvider,
  type RemoteChainHalt,
  type RemoteChainProvider,
} from '@dotli/protocol';
import { createCoreRpcChainProvider, isCoreRpcChainSupported } from '@dotli/resolver';

import { log } from '@dotli/shared';
import { ERRORS } from '../errors.js';
import { createFrameChainTransport } from './frame-transport.js';
import { createRedialGate, type RedialGate } from './redial-gate.js';

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

/**
 * When a product may boot a protocol frame after one died, shared by every
 * core connection. It opens 1 s after a frame halt; each dial through it shuts
 * it again and doubles the delay, up to 30 s. A lease while a frame is up or
 * booting boots nothing, so it does not ask the gate.
 *
 * A frame that reports ready ends the wait but keeps the delay: in
 * smoldot-direct a new frame reports ready before its light client has
 * connected a chain, and may answer for a while before it fails, so neither
 * proves it works. Only uptime does: a frame halt more than 30 s after the
 * last dial through the gate starts again at 1 s.
 */
const frameGate = createRedialGate(1_000);
onProtocolReady(() => {
  frameGate.open();
});

/**
 * When a product may rebuild a chain after it halted, one gate per chain,
 * shared by every core connection on it: a chain that halts each time it is
 * rebuilt would otherwise be re-added and re-synced on each re-follow. The
 * first rebuild after a halt goes at once. A halt within 30 s of the last
 * rebuild through the gate waits 1 s, doubling to 30 s; one after more than
 * 30 s starts over. A lease while another connection has rebuilt the chain
 * rebuilds nothing, so it does not ask the gate.
 */
const chainGates = new Map<string, RedialGate>();

function chainGate(genesisHash: string): RedialGate {
  const key = genesisHash.toLowerCase();
  let gate = chainGates.get(key);
  if (gate === undefined) {
    gate = createRedialGate(0);
    chainGates.set(key, gate);
  }
  return gate;
}

/**
 * A core connection over leases on the host pool: one at once, and another on
 * the first send after a halt.
 */
function toConnection(genesisHash: string, pool: ChainPool): PlatformJsonRpcConnection {
  const first = pool.getLocalProvider(genesisHash);
  if (!first) {
    throw new Error(ERRORS.CHAIN_PROVIDER_UNAVAILABLE);
  }
  const queue: string[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  let lease: JsonRpcConnection | null = null;
  // Why the last lease halted, until a new one is taken: the next one waits
  // for that reason's gate.
  let haltedBy: RemoteChainHalt | null = null;

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
  // takes a new lease, which rebuilds the chain: it waits for the chain's gate
  // after `'chain'`, and for the frame gate after `'frame'`, where that lease
  // boots a frame.
  const open = (provider: LeaseProvider): void => {
    // Per lease, so a halt heard while `provider` is still running, or a late
    // one from a replaced lease, never touches another lease.
    const slot = { connection: null as JsonRpcConnection | null, halted: false };
    const connection = provider(deliver, error => {
      slot.halted = true;
      if (lease === slot.connection) {
        lease = null;
      }
      haltedBy = haltReasonOf(error);
      (haltedBy === 'frame' ? frameGate : chainGate(genesisHash)).noteHalt();
    });
    if (!slot.halted) {
      slot.connection = lease = connection;
      // Only a lease taken clears it: a failed one keeps the gate.
      haltedBy = null;
    }
  };
  const reopen = (): JsonRpcConnection | null => {
    // A frame something else started is up or on its way up, or another
    // connection has rebuilt the chain: that lease dials nothing, and passes.
    const mayDial =
      haltedBy === 'frame'
        ? isProtocolReady() || isProtocolBooting() || frameGate.tryDial()
        : pool.status(genesisHash) !== 'disconnected' || chainGate(genesisHash).tryDial();
    if (!mayDial) {
      // Answered at once, as the product's own retry is.
      return null;
    }
    try {
      const provider = pool.getLocalProvider(genesisHash);
      if (provider === null) {
        log.warn(`[dot.li truapi-chain] no chain transport for ${genesisHash} after a halt`);
        return null;
      }
      open(provider);
      return lease;
    } catch (error: unknown) {
      log.warn(`[dot.li truapi-chain] re-leasing ${genesisHash} failed:`, error);
      return null;
    }
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
          deliver({ jsonrpc: '2.0', id: parsed.id, error: chainHaltedError() });
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
    // This callback is shared by product-forwarded calls and core-owned
    // Bulletin operations. `featureSupported` is the dApp advertisement; this
    // seam cannot enforce that advertised subset.
    const [isSupported, backend] =
      getBackend() === 'rpc-gateway' ? [isCoreRpcChainSupported, 'RPC'] : [isRemoteChainConnectable, 'smoldot'];
    if (!isSupported(genesisHash)) {
      log.warn(`[dot.li truapi-chain] ${backend} backend doesn't support ${genesisHash}; product call will fail`);
      throw new Error(`Unsupported ${backend} chain: ${genesisHash}`);
    }
    return Promise.resolve(toConnection(genesisHash, pool));
  };
}
