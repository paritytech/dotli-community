// Without this callback truapi-server would run its own bundled smoldot beside the protocol frame's,
// ignoring the backend the user selected.
//
// Every core connection leases the host chain pool. When a transport dies for good, its connections
// still deliver what was queued and stay open, since truapi-host ignores a stream's end. The next
// request takes a new lease, which rebuilds the chain through a backoff.

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
import { withTrustedSubmitFallback } from './light-client-submit-fallback.js';

// This explicit submit-only fallback is independent of the selected light
// client. Its lazy RPC leases use the same canonical replay/watch policy.
const trustedSubmitPool = createChainPool({
  createTransport: createCoreRpcChainProvider,
  destroyDelay: 0,
});
import { recordBestBlock, recordChainActivity } from '../network-monitor.js';

/** Every backend switch reloads the page, so a pool entry never outlives its backend. */
export function createHostChainPool(destroyDelay?: number): ChainPool {
  return createChainPool({
    // Unset, an idle chain closes after the pool's default minute. Reopening is cheap on every
    // backend, since the frame keeps the light client's chain.
    ...(destroyDelay === undefined ? {} : { destroyDelay }),
    createTransport: (genesisHash, hooks) => {
      if (getBackend() === 'rpc-gateway') {
        return createCoreRpcChainProvider(genesisHash, hooks);
      }
      const lightClient = createFrameChainTransport(genesisHash, hooks);
      return lightClient === null
        ? null
        : withTrustedSubmitFallback(lightClient, () => trustedSubmitPool.getLocalProvider(genesisHash), genesisHash);
    },
  });
}

const hostChainPool = createHostChainPool();
// The network panel never leases a chain, so it never opens or keeps one. It follows only those someone holds.
hostChainPool.watch({ onActivity: recordChainActivity, onBestBlock: recordBestBlock });

/** The rpc-gateway name resolver reads through this lease instead of dialing its own socket. */
export function hostAssetHubProvider(): JsonRpcProvider {
  return requireBrokerLocalProvider(hostChainPool, getActiveServicesConfig().assethub.genesis, 'Asset Hub');
}

/**
 * Host-page chain users share the products' connection to each chain. A halt reaches them as
 * `'frame'` for a dead protocol frame, `'chain'` otherwise.
 */
export function hostChainProvider(genesisHash: string, pool: ChainPool = hostChainPool): RemoteChainProvider | null {
  if (!isRemoteChainConnectable(genesisHash)) {
    return null;
  }
  const lease = pool.getLocalProvider(genesisHash, 'host');
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
 * A ready frame ends the wait but keeps the delay, because in smoldot-direct a new frame reports
 * ready before its light client connects a chain, and only uptime proves it works.
 */
const frameGate = createRedialGate(1_000);
onProtocolReady(() => {
  frameGate.open();
});

/** A chain that halts each time it is rebuilt would otherwise be re-synced on each re-follow. */
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

/** Takes one lease at once and another on the first send after a halt. */
function toConnection(genesisHash: string, pool: ChainPool): PlatformJsonRpcConnection {
  const first = pool.getLocalProvider(genesisHash, 'truapi-core');
  if (!first) {
    throw new Error(ERRORS.CHAIN_PROVIDER_UNAVAILABLE);
  }
  const queue: string[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  let lease: JsonRpcConnection | null = null;
  // Why the last lease halted, so the next one waits for that reason's gate.
  let haltedBy: RemoteChainHalt | null = null;

  const deliver = (message: unknown): void => {
    if (closed) {
      return;
    }
    queue.push(JSON.stringify(message));
    wake?.();
    wake = null;
  };
  // A halt drops the lease but the stream stays open, since truapi-host ignores its end and keeps
  // sending. The next send takes a new lease, behind the chain gate or the frame gate.
  const open = (provider: LeaseProvider): void => {
    // Per lease, so a halt heard while `provider` still runs, or a late one from a replaced lease,
    // never touches another lease.
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
      // A failed lease keeps the gate.
      haltedBy = null;
    }
  };
  const reopen = (): JsonRpcConnection | null => {
    const mayDial =
      haltedBy === 'frame'
        ? isProtocolReady() || isProtocolBooting() || frameGate.tryDial()
        : pool.status(genesisHash) !== 'disconnected' || chainGate(genesisHash).tryDial();
    if (!mayDial) {
      // Answered at once, as the product's own retry is.
      return null;
    }
    try {
      const provider = pool.getLocalProvider(genesisHash, 'truapi-core');
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
      if (closed) {
        throw new Error(ERRORS.CHAIN_PROVIDER_UNAVAILABLE);
      }
      const parsed: unknown = JSON.parse(request);
      if (!isJsonRpcRequest(parsed)) {
        throw new Error(ERRORS.INVALID_JSON_RPC_REQUEST);
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
    // Core-owned Bulletin operations also come through here, so this cannot enforce the subset
    // `featureSupported` advertises.
    const [isSupported, backend] =
      getBackend() === 'rpc-gateway' ? [isCoreRpcChainSupported, 'RPC'] : [isRemoteChainConnectable, 'smoldot'];
    if (!isSupported(genesisHash)) {
      log.warn(`[dot.li truapi-chain] ${backend} backend doesn't support ${genesisHash}; product call will fail`);
      throw new Error(`Unsupported ${backend} chain: ${genesisHash}`);
    }
    return Promise.resolve(toConnection(genesisHash, pool));
  };
}
