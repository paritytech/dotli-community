// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Without this callback truapi-server would run its own bundled smoldot beside the protocol frame's,
// ignoring the backend the user selected.
//
// Every core connection leases the host chain pool. When a transport dies for good, its connections
// still deliver what was queued and stay open, since truapi-host ignores a stream's end. The next
// request takes a new lease, which rebuilds the chain through a backoff.

import { bytesToHex } from '@parity/truapi/scale';
import type { JsonRpcConnection, JsonRpcRequest } from '@polkadot-api/json-rpc-provider';
import type { JsonRpcProvider } from '@polkadot-api/json-rpc-provider';
import type { ChainProvider } from '@parity/truapi-host';
import type { PlatformJsonRpcConnection } from '@parity/truapi-host';
import { getActiveServicesConfig, getBackend, type Backend } from '@dotli/config';
import {
  protocolClient,
  isRemoteChainConnectable,
  type ProtocolStatus,
  type RemoteChainProvider,
} from '@dotli/protocol';
import {
  chainHaltedError,
  createChainPool,
  createCoreRpcChainProvider,
  haltReasonOf,
  isCoreRpcChainSupported,
  jsonRpcError,
  requireBrokerLocalProvider,
  type ChainPool,
  type ChainPoolWatcher,
  type ChainTransportHooks,
  type LeaseProvider,
  type RemoteChainHalt,
} from '@dotli/chains';
import { captureException, m, spans as S } from '@dotli/metrics';
import { errorName, log } from '@dotli/shared';
import { ERRORS } from '../errors.js';
import { createFrameChainTransport, type RemoteChainFactory } from './frame-transport.js';
import { createRedialGate, type RedialGate } from './redial-gate.js';

/** Where the host's chains come from on each backend. */
export interface HostChainSources {
  /** The backend in force. */
  backend: () => Backend;
  /** The light client backends' connections to the protocol frame. */
  remoteChain: RemoteChainFactory;
  isRemoteChainConnectable: (genesisHash: string) => boolean;
  /** Trusted Providers' own sockets. */
  rpcChain: (genesisHash: string, hooks: ChainTransportHooks) => JsonRpcProvider | null;
  isRpcChainSupported: (genesisHash: string) => boolean;
}

const pageSources: HostChainSources = {
  backend: getBackend,
  remoteChain: genesisHash => protocolClient().createRemoteChainProvider(genesisHash),
  isRemoteChainConnectable,
  rpcChain: createCoreRpcChainProvider,
  isRpcChainSupported: isCoreRpcChainSupported,
};

export interface HostChainPoolOptions extends Partial<Pick<HostChainSources, 'backend' | 'remoteChain' | 'rpcChain'>> {
  /** Unset, an idle chain closes after the pool's default minute. */
  destroyDelay?: number | undefined;
}

/** Every backend switch reloads the page, so a pool entry never outlives its backend. */
export function createHostChainPool({
  destroyDelay,
  backend = pageSources.backend,
  remoteChain = pageSources.remoteChain,
  rpcChain = pageSources.rpcChain,
}: HostChainPoolOptions = {}): ChainPool {
  return createChainPool({
    // Reopening is cheap on every backend, since the frame keeps the light client's chain.
    ...(destroyDelay === undefined ? {} : { destroyDelay }),
    createTransport: (genesisHash, hooks) =>
      backend() === 'rpc-gateway'
        ? rpcChain(genesisHash, hooks)
        : createFrameChainTransport(genesisHash, hooks, remoteChain),
  });
}

/** The protocol frame's status, read when a lease that died with the frame would be taken again. */
export interface FrameStatusSource {
  getProtocolStatus(): ProtocolStatus;
}

const protocolFrame: FrameStatusSource = { getProtocolStatus: () => protocolClient().getProtocolStatus() };

const hostChainPool = createHostChainPool();

/**
 * Reports who holds each host chain and its best blocks. The watcher never leases a chain, so it never opens or keeps
 * one. It follows only those someone holds.
 */
export function watchHostChains(watcher: ChainPoolWatcher, pool: ChainPool = hostChainPool): () => void {
  return pool.watch(watcher);
}

/** The rpc-gateway name resolver reads through this lease instead of dialing its own socket. */
export function hostAssetHubProvider(pool: ChainPool = hostChainPool): JsonRpcProvider {
  return requireBrokerLocalProvider(pool, getActiveServicesConfig().assethub.genesis, 'Asset Hub');
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
 * A chain that halts each time it is rebuilt would otherwise be re-synced on each re-follow, and a frame that fails
 * each boot booted again. Kept per pool, since they hold back that pool's leases.
 */
interface PoolGates {
  frame: RedialGate;
  chains: Map<string, RedialGate>;
}

const poolGates = new WeakMap<ChainPool, PoolGates>();

function gatesOf(pool: ChainPool): PoolGates {
  let gates = poolGates.get(pool);
  if (gates === undefined) {
    gates = { frame: createRedialGate(), chains: new Map() };
    poolGates.set(pool, gates);
  }
  return gates;
}

function chainGate(pool: ChainPool, genesisHash: string): RedialGate {
  const { chains } = gatesOf(pool);
  const key = genesisHash.toLowerCase();
  let gate = chains.get(key);
  if (gate === undefined) {
    gate = createRedialGate();
    chains.set(key, gate);
  }
  return gate;
}

/** Takes one lease at once and another on the first send after a halt. */
function toConnection(genesisHash: string, pool: ChainPool, frame: FrameStatusSource): PlatformJsonRpcConnection {
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
  // sending. The next send takes a new lease, behind the frame gate or the chain gate.
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
      (haltedBy === 'frame' ? gatesOf(pool).frame : chainGate(pool, genesisHash)).noteHalt();
    });
    if (!slot.halted) {
      slot.connection = lease = connection;
      // A failed lease keeps the gate.
      haltedBy = null;
    }
  };
  const reopen = (): JsonRpcConnection | null => {
    // Only a failed frame holds a lease back. A lease taken then boots it, so a frame that fails every boot is dialled
    // only as its gate allows.
    const mayDial =
      haltedBy === 'frame'
        ? frame.getProtocolStatus() !== 'failed' || gatesOf(pool).frame.tryDial()
        : pool.status(genesisHash) !== 'disconnected' || chainGate(pool, genesisHash).tryDial();
    if (!mayDial) {
      // Answered at once, as the product's own retry is.
      return null;
    }
    try {
      const provider = pool.getLocalProvider(genesisHash, 'truapi-core');
      if (provider === null) {
        // The backend no longer serves this chain, as after a switch, so the product is answered at once.
        log.event('chain has no transport after a halt', { flow: 'protocol', genesisHash });
        m.count(S.TRUAPI_CHAIN_REOPEN, { outcome: 'error', reason: 'no_transport' });
        return null;
      }
      open(provider);
      m.count(S.TRUAPI_CHAIN_REOPEN, lease === null ? { outcome: 'error', reason: 'halted' } : { outcome: 'ok' });
      return lease;
    } catch (error: unknown) {
      log.error(`[dot.li truapi-chain] re-leasing ${genesisHash} failed:`, error);
      captureException(error, { flow: 'protocol', step: 'chain_reopen' });
      m.count(S.TRUAPI_CHAIN_REOPEN, { outcome: 'error', reason: errorName(error) ?? 'unknown' });
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
          deliver(jsonRpcError(parsed.id, chainHaltedError()));
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

export function createChainConnect(
  pool: ChainPool = hostChainPool,
  frame: FrameStatusSource = protocolFrame,
  sources: Partial<Pick<HostChainSources, 'backend' | 'isRemoteChainConnectable' | 'isRpcChainSupported'>> = {},
): ChainProvider['connect'] {
  const {
    backend: backendInForce = pageSources.backend,
    isRemoteChainConnectable: isRemoteSupported = pageSources.isRemoteChainConnectable,
    isRpcChainSupported: isRpcSupported = pageSources.isRpcChainSupported,
  } = sources;
  return genesisHashBytes => {
    const genesisHash = bytesToHex(genesisHashBytes);
    // Core-owned Bulletin operations also come through here, so this cannot enforce the subset
    // `featureSupported` advertises.
    const [isSupported, backend] =
      backendInForce() === 'rpc-gateway' ? [isRpcSupported, 'RPC'] : [isRemoteSupported, 'smoldot'];
    if (!isSupported(genesisHash)) {
      log.warn(`[dot.li truapi-chain] ${backend} backend doesn't support ${genesisHash}; product call will fail`);
      throw new Error(`Unsupported ${backend} chain: ${genesisHash}`);
    }
    return Promise.resolve(toConnection(genesisHash, pool, frame));
  };
}
