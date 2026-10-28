// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Without this callback truapi-server would run its own bundled smoldot beside the protocol frame's,
// ignoring the backend the user selected.
//
// Every core connection leases the host chain pool. When a transport dies for good, its connections
// still deliver what was queued and stay open, since truapi-host ignores a stream's end. The next
// request takes a new lease, which rebuilds the chain through a backoff.

import type { JsonRpcConnection, JsonRpcRequest } from '@polkadot-api/json-rpc-provider';
import type { ChainProvider } from '@parity/truapi-host';
import type { PlatformJsonRpcConnection } from '@parity/truapi-host';
import {
  createChainHaltedError,
  createJsonRpcError,
  getHaltReason,
  type ChainPool,
  type LeaseProvider,
  type RemoteChainHalt,
} from '@dotli/chains';
import { captureException, m, spans as S } from '@dotli/metrics';
import { getErrorName, isRecord, log, toHex } from '@dotli/shared';
import { ERRORS } from '../errors.js';
import {
  hostChainPool,
  pageSources,
  protocolFrame,
  type FrameStatusSource,
  type HostChainSources,
} from './createHostChainPool.js';
import { createRedialGate, type RedialGate } from './createRedialGate.js';

type Params = {
  /** The pool the connections lease. The page's host chain pool by default. */
  pool?: ChainPool;
  /** The protocol frame whose status holds back a lease that died with it. The page's frame by default. */
  frame?: FrameStatusSource;
  /** Which backend is in force and which chains it serves. The page's sources by default, each one apart. */
  sources?: Partial<Pick<HostChainSources, 'backend' | 'isRemoteChainConnectable' | 'isRpcChainSupported'>>;
};

type CreateConnectionParams = {
  genesisHash: string;
  pool: ChainPool;
  frame: FrameStatusSource;
};

/** Which chains the backend in force serves, and its name in the log. */
type BackendSupport = {
  isSupported: (genesisHash: string) => boolean;
  backend: string;
};

/** One lease's own state, so a halt heard late never touches another lease. */
type LeaseSlot = {
  connection: JsonRpcConnection | null;
  halted: boolean;
};

/**
 * A chain that halts each time it is rebuilt would otherwise be re-synced on each re-follow, and a frame that fails
 * each boot booted again. Kept per pool, since they hold back that pool's leases.
 */
type PoolGates = {
  frame: RedialGate;
  chains: Map<string, RedialGate>;
};

const poolGates = new WeakMap<ChainPool, PoolGates>();

/**
 * Connects the core to a chain over the host pool. Throws when the backend in force does not serve the chain, before
 * any transport is built, or when the pool has no transport for it.
 */
export function createChainConnect({
  pool = hostChainPool,
  frame = protocolFrame,
  sources = {},
}: Params = {}): ChainProvider['connect'] {
  const {
    backend: backendInForce = pageSources.backend,
    isRemoteChainConnectable: isRemoteSupported = pageSources.isRemoteChainConnectable,
    isRpcChainSupported: isRpcSupported = pageSources.isRpcChainSupported,
  } = sources;

  function getBackendSupport(): BackendSupport {
    switch (backendInForce()) {
      case 'rpc-gateway':
        return { isSupported: isRpcSupported, backend: 'RPC' };
      case 'smoldot-direct':
      case 'smoldot-shared-worker':
        return { isSupported: isRemoteSupported, backend: 'smoldot' };
    }
  }

  function connect(genesisHashBytes: Uint8Array): ReturnType<ChainProvider['connect']> {
    const genesisHash = toHex(genesisHashBytes);
    // Core-owned Bulletin operations also come through here, so every chain the backend serves is let through.
    const { isSupported, backend } = getBackendSupport();
    if (!isSupported(genesisHash)) {
      log.warn(`[dot.li truapi-chain] ${backend} backend doesn't support ${genesisHash}; product call will fail`);
      throw new Error(`Unsupported ${backend} chain: ${genesisHash}`);
    }
    return Promise.resolve(createConnection({ genesisHash, pool, frame }));
  }

  return connect;
}

function isJsonRpcRequest(value: unknown): value is JsonRpcRequest<unknown> {
  if (!isRecord(value)) {
    return false;
  }
  const id = value['id'];
  return (
    value['jsonrpc'] === '2.0' &&
    typeof value['method'] === 'string' &&
    (id === undefined || id === null || typeof id === 'string' || typeof id === 'number')
  );
}

function getPoolGates(pool: ChainPool): PoolGates {
  let gates = poolGates.get(pool);
  if (gates === undefined) {
    gates = { frame: createRedialGate(), chains: new Map() };
    poolGates.set(pool, gates);
  }
  return gates;
}

function getChainGate(pool: ChainPool, genesisHash: string): RedialGate {
  const { chains } = getPoolGates(pool);
  const key = genesisHash.toLowerCase();
  let gate = chains.get(key);
  if (gate === undefined) {
    gate = createRedialGate();
    chains.set(key, gate);
  }
  return gate;
}

/** Takes one lease at once and another on the first send after a halt. */
function createConnection({ genesisHash, pool, frame }: CreateConnectionParams): PlatformJsonRpcConnection {
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

  function deliver(message: unknown): void {
    if (closed) {
      return;
    }
    queue.push(JSON.stringify(message));
    wake?.();
    wake = null;
  }

  function getHaltGate(reason: RemoteChainHalt): RedialGate {
    switch (reason) {
      case 'frame':
        return getPoolGates(pool).frame;
      case 'chain':
        return getChainGate(pool, genesisHash);
    }
  }

  // A halt drops the lease but the stream stays open, since truapi-host ignores its end and keeps
  // sending. The next send takes a new lease, behind the frame gate or the chain gate.
  function open(provider: LeaseProvider): void {
    // Per lease, so a halt heard while `provider` still runs, or a late one from a replaced lease,
    // never touches another lease.
    const slot: LeaseSlot = { connection: null, halted: false };
    const connection = provider(deliver, error => {
      slot.halted = true;
      if (lease === slot.connection) {
        lease = null;
      }
      const reason = getHaltReason(error);
      haltedBy = reason;
      getHaltGate(reason).noteHalt();
    });
    if (!slot.halted) {
      slot.connection = lease = connection;
      // A failed lease keeps the gate.
      haltedBy = null;
    }
  }

  // Only a failed frame holds a lease back. A lease taken then boots it, so a frame that fails every boot is dialled
  // only as its gate allows.
  function tryRedial(): boolean {
    switch (haltedBy) {
      case 'frame':
        return frame.getProtocolStatus() !== 'failed' || getPoolGates(pool).frame.tryDial();
      case 'chain':
      case null:
        return pool.status(genesisHash) !== 'disconnected' || getChainGate(pool, genesisHash).tryDial();
    }
  }

  function reopen(): JsonRpcConnection | null {
    if (!tryRedial()) {
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
      m.count(S.TRUAPI_CHAIN_REOPEN, { outcome: 'error', reason: getErrorName(error) ?? 'unknown' });
      return null;
    }
  }

  // A call, so the check after the drain isn't narrowed by earlier ones.
  function isClosed(): boolean {
    return closed;
  }

  function close(): void {
    if (closed) {
      return;
    }
    closed = true;
    lease?.disconnect();
    lease = null;
    wake?.();
    wake = null;
  }

  open(first);

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
          deliver(createJsonRpcError(parsed.id, createChainHaltedError()));
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
