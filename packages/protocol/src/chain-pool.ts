// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// One connection per chain, shared by every consumer in this JS context. Each lease is a broker
// session. An entry closes `destroyDelay` after its last lease is released, and at once when its
// transport halts.

import type { JsonRpcConnection, JsonRpcMessage, JsonRpcProvider } from '@polkadot-api/json-rpc-provider';
import type { ChainTransportHooks, ConnectionStatus } from '@dotli/resolver';
import { ChainBroker, type ChainBrokerManager, type StringJsonRpcConnection } from './broker.js';
import { createWatchGuard, type WatchGuard } from './watch-guard.js';

/** A provider whose connections also hear when their chain's transport halts. */
export type LeaseProvider = (
  onMessage: (message: JsonRpcMessage) => void,
  onHalt?: (error?: unknown) => void,
) => JsonRpcConnection;

export interface ChainPoolOptions {
  /** Build a chain's transport, or `null` when this context cannot reach it. */
  createTransport: (genesisHash: string, hooks: ChainTransportHooks) => JsonRpcProvider | null;
  /**
   * How long a chain outlives its last lease, in ms. `Infinity` keeps it. A
   * function is asked for the chain's genesis hash when its countdown starts.
   */
  destroyDelay?: number | ((genesisHash: string) => number);
}

export interface ChainPool extends ChainBrokerManager {
  connectRemote(
    genesisHash: string,
    connectionId: string,
    onMessage: (message: string) => void,
    onHalt?: (error?: unknown) => void,
  ): StringJsonRpcConnection | null;
  getLocalProvider(genesisHash: string): LeaseProvider | null;
  status(genesisHash: string): ConnectionStatus;
  onStatusChanged(genesisHash: string, callback: (status: ConnectionStatus) => void): () => void;
  /** Drops every pausable transport's socket. Leases and refcounts stay. */
  pauseAll(): void;
  /** Tracked statement subscriptions are replayed. */
  resumeAll(): void;
}

interface Entry {
  readonly key: string;
  readonly transport: JsonRpcProvider;
  readonly guard: WatchGuard;
  readonly broker: ChainBroker;
  leases: number;
  destroyTimer: ReturnType<typeof setTimeout> | null;
  live: boolean;
}

const DEFAULT_DESTROY_DELAY_MS = 60_000;

interface Pausable {
  pause: () => void;
  resume: () => void;
}

type PausableProvider = JsonRpcProvider & Pausable;

/** Duck-typed because the ws provider package exports no pausability check. */
function isPausable(transport: JsonRpcProvider): transport is PausableProvider {
  const candidate = transport as Partial<PausableProvider>;
  return typeof candidate.pause === 'function' && typeof candidate.resume === 'function';
}

export function createChainPool(options: ChainPoolOptions): ChainPool {
  const destroyDelayOption = options.destroyDelay ?? DEFAULT_DESTROY_DELAY_MS;
  const entries = new Map<string, Entry>();
  const statuses = new Map<string, ConnectionStatus>();
  const listeners = new Map<string, Set<(status: ConnectionStatus) => void>>();
  let sessionCounter = 0;
  // Survives every entry: a chain first leased while paused comes up paused.
  let paused = false;

  function setStatus(key: string, status: ConnectionStatus): void {
    if (statuses.get(key) === status) {
      return;
    }
    statuses.set(key, status);
    for (const callback of [...(listeners.get(key) ?? [])]) {
      try {
        callback(status);
        // eslint-disable-next-line no-restricted-syntax -- defensive multicast: one listener's throw must not keep the others from the status, nor reach the transport's status callback.
      } catch {
        /* the other listeners still hear the status */
      }
    }
  }

  /** Close an entry: quietly on release or unload, telling its leases on a halt. */
  function destroy(entry: Entry, halt: { error: unknown } | null): void {
    if (!entry.live) {
      return;
    }
    entry.live = false;
    if (entry.destroyTimer !== null) {
      clearTimeout(entry.destroyTimer);
      entry.destroyTimer = null;
    }
    entries.delete(entry.key);
    // Before the broker call: a halt handler may lease the chain again, and
    // the rebuilt entry's status must not be overwritten afterwards.
    setStatus(entry.key, 'disconnected');
    if (halt === null) {
      entry.broker.disconnectAll();
    } else {
      entry.broker.halt(halt.error);
    }
  }

  function build(key: string): Entry | null {
    // Null until the transport exists, so a hook that fires earlier has nothing to report on.
    let entry: Entry | null = null;
    const hooks: ChainTransportHooks = {
      onStatus: status => {
        if (entry?.live !== true) {
          return;
        }
        entry.guard.onStatus(status);
        setStatus(key, status);
      },
      onHalt: error => {
        if (entry?.live === true) {
          destroy(entry, { error });
        }
      },
    };
    const transport = options.createTransport(key, hooks);
    if (transport === null) {
      return null;
    }
    // Paused before the broker first calls the transport, so its socket does
    // not open until the resume.
    const builtPaused = paused && isPausable(transport);
    if (builtPaused) {
      transport.pause();
    }
    const guard = createWatchGuard(transport);
    entry = {
      key,
      transport,
      guard,
      // The pool removes its entries itself, in `destroy`.
      broker: new ChainBroker(guard.provider, () => undefined),
      leases: 0,
      destroyTimer: null,
      live: true,
    };
    entries.set(key, entry);
    setStatus(key, builtPaused ? 'disconnected' : 'connecting');
    return entry;
  }

  function acquire(genesisHash: string): Entry | null {
    const key = genesisHash.toLowerCase();
    const entry = entries.get(key) ?? build(key);
    if (entry !== null && entry.destroyTimer !== null) {
      clearTimeout(entry.destroyTimer);
      entry.destroyTimer = null;
    }
    return entry;
  }

  function idle(entry: Entry): void {
    if (entry.leases > 0 || !entry.live || entry.destroyTimer !== null) {
      return;
    }
    const destroyDelay = typeof destroyDelayOption === 'function' ? destroyDelayOption(entry.key) : destroyDelayOption;
    if (destroyDelay <= 0) {
      destroy(entry, null);
      return;
    }
    // `setTimeout` clamps a non-finite delay to about 1 ms, which would close the entry at once.
    if (!Number.isFinite(destroyDelay)) {
      return;
    }
    entry.destroyTimer = setTimeout(() => {
      entry.destroyTimer = null;
      destroy(entry, null);
    }, destroyDelay);
  }

  /** Count `connection` as a lease on `entry`, released once by its first `disconnect()`. */
  function lease<C extends { disconnect: () => void }>(entry: Entry, connection: C): C {
    entry.leases += 1;
    let released = false;
    return {
      ...connection,
      disconnect: () => {
        if (released) {
          return;
        }
        released = true;
        connection.disconnect();
        // A halted entry is already gone, so its leases count for nothing.
        if (!entry.live) {
          return;
        }
        entry.leases -= 1;
        idle(entry);
      },
    };
  }

  return {
    connectRemote(genesisHash, connectionId, onMessage, onHalt) {
      const entry = acquire(genesisHash);
      if (entry === null) {
        return null;
      }
      try {
        // Prefixed so no remote id can collide with a local lease's `local:N`.
        return lease(
          entry,
          entry.broker.connect(
            `remote:${connectionId}`,
            onMessage as (message: unknown) => void,
            'string',
            onHalt ?? null,
          ),
        );
      } catch (error) {
        idle(entry);
        throw error;
      }
    },

    getLocalProvider(genesisHash) {
      const entry = acquire(genesisHash);
      if (entry === null) {
        return null;
      }
      // Callers call the provider at once. One that never does must not keep
      // the entry for good, so its countdown starts once this turn is over.
      queueMicrotask(() => {
        idle(entry);
      });
      return (onMessage, onHalt) => {
        const current = acquire(genesisHash);
        if (current === null) {
          throw new Error(`No chain transport for ${genesisHash}`);
        }
        const sessionId = `local:${sessionCounter.toString(36)}`;
        sessionCounter += 1;
        try {
          return lease(
            current,
            current.broker.connect(sessionId, onMessage as (message: unknown) => void, 'object', onHalt ?? null),
          ) as JsonRpcConnection;
        } catch (error) {
          idle(current);
          throw error;
        }
      };
    },

    disconnectAll() {
      for (const entry of [...entries.values()]) {
        destroy(entry, null);
      }
    },

    status(genesisHash) {
      return statuses.get(genesisHash.toLowerCase()) ?? 'disconnected';
    },

    onStatusChanged(genesisHash, callback) {
      const key = genesisHash.toLowerCase();
      const callbacks = listeners.get(key) ?? new Set<(status: ConnectionStatus) => void>();
      listeners.set(key, callbacks);
      callbacks.add(callback);
      return () => {
        callbacks.delete(callback);
      };
    },

    pauseAll() {
      if (paused) {
        return;
      }
      paused = true;
      for (const entry of entries.values()) {
        if (isPausable(entry.transport)) {
          entry.transport.pause();
        }
      }
    },

    resumeAll() {
      if (!paused) {
        return;
      }
      paused = false;
      for (const entry of entries.values()) {
        if (isPausable(entry.transport)) {
          entry.transport.resume();
        }
      }
    },
  };
}
