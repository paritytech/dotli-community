// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// One connection per chain, shared by every consumer in this JS context. Each lease is a broker
// session. An entry closes `destroyDelay` after its last lease is released, and at once when its
// transport halts. While someone watches the pool, each held chain also carries the watchers' own follow, which is a
// session but not a lease. A pause closes every chain's connection under the same leases, and a resume opens it again.

import type { JsonRpcConnection, JsonRpcMessage, JsonRpcProvider } from '@polkadot-api/json-rpc-provider';
import type { ChainTransportHooks, ConnectionStatus } from './transportHooks.js';
import { reportDefect, reportListener, spans as S } from '@dotli/metrics';
import { createListenerSet, log, type ListenerSet } from '@dotli/shared';
import { createChainBroker, type ChainBroker } from './createChainBroker.js';
import { createBrokerWarner, type BrokerWarner } from './createBrokerWarner.js';
import { createPausableTransport, type PausableTransport } from './createPausableTransport.js';
import { createWatchGuard, type WatchGuard } from './createWatchGuard.js';
import { openWatchFollow } from './openWatchFollow.js';
import type { ChainBrokerManager, StringJsonRpcConnection } from './requireBrokerLocalProvider.js';

/** A provider whose connections also hear when their chain's transport halts. */
export type LeaseProvider = (
  onMessage: (message: JsonRpcMessage) => void,
  onHalt?: (error?: unknown) => void,
) => JsonRpcConnection;

/** One chain as the pool holds it, for an observer that must not hold it too. */
export type ChainActivity = {
  /** Lowercase. */
  readonly genesisHash: string;
  /**
   * Leases held, the watchers' own follow not counted. 0 once the last is released, while the chain waits out its
   * destroy delay, and that follow has stopped by then.
   */
  readonly consumers: number;
  readonly status: ConnectionStatus;
  /** A follow is established, the watchers' own included. */
  readonly following: boolean;
};

export type ChainPoolWatcher = {
  /** Hears a chain's leases, status or follow change. */
  onActivity(activity: ChainActivity): void;
  /** Hears the number of a held chain's new best block. */
  onBestBlock(genesisHash: string, blockNumber: number): void;
};

type Params = {
  /** Build a chain's transport, or `null` when this context cannot reach it. */
  createTransport: (genesisHash: string, hooks: ChainTransportHooks) => JsonRpcProvider | null;
  /** How long a chain outlives its last lease, in ms. `Infinity` keeps it. */
  destroyDelay?: number;
};

type ConnectRemoteParams = Parameters<ChainBrokerManager['connectRemote']>[0] & {
  /** Hears the chain's halt. */
  onHalt?: (error?: unknown) => void;
};
type GetLocalProviderParams = NonNullable<Parameters<ChainBrokerManager['getLocalProvider']>[1]>;

export type ChainPool = {
  /**
   * Leases the chain for a remote session under `connectionId`, with its messages sent to `onMessage` as JSON text
   * and its halt to `onHalt`. Returns `null` when this context cannot reach the chain, and throws when
   * `connectionId` already has a session.
   */
  connectRemote(params: ConnectRemoteParams): StringJsonRpcConnection | null;
  /**
   * A provider whose connections are leases on the chain, or `null` when this context cannot reach it. Calling the
   * provider throws when the chain's transport is gone and cannot be built again by then. `holder` names the lease in
   * debug logs.
   */
  getLocalProvider(genesisHash: string, params?: GetLocalProviderParams): LeaseProvider | null;
  /** The chain's transport status, `disconnected` for a chain the pool does not hold. */
  status(genesisHash: string): ConnectionStatus;
  /** Hears each change of the chain's status, and returns the unsubscribe. */
  onStatusChanged(genesisHash: string, callback: (status: ConnectionStatus) => void): () => void;
  /**
   * Reports each chain's leases, status, follow and best blocks. The chains held now are replayed first. A chain
   * someone holds is followed for its blocks until its last lease is released, and no chain is opened or kept.
   */
  watch(watcher: ChainPoolWatcher): () => void;
  /**
   * Closes every chain and its sessions, without telling them of a halt. Never throws, and reports a chain that fails
   * to close.
   */
  disconnectAll(): void;
  /**
   * Closes every chain's connection at once and keeps every lease. A chain built while paused starts closed. A call
   * while paused does nothing. Never throws, and reports a chain that fails to pause and halts it.
   */
  pause(): void;
  /**
   * Opens every closed chain a lease holds again. A chain that only waits out its destroy delay stays closed until a
   * lease takes it. A call while not paused does nothing. Never throws, and reports a chain that fails to resume and
   * halts it.
   */
  resume(): void;
};

type Entry = {
  readonly key: string;
  readonly pausable: PausableTransport;
  readonly guard: WatchGuard;
  readonly broker: ChainBroker;
  leases: number;
  destroyTimer: ReturnType<typeof setTimeout> | null;
  live: boolean;
  following: boolean;
  watchFollow: { disconnect: () => void } | null;
};

type LeaseParams<Connection> = {
  /** The chain the lease holds. */
  entry: Entry;
  /** The broker session the lease wraps. */
  connection: Connection;
  /** Names the lease in debug logs. */
  holder: string;
};

type HaltOnFailureParams = {
  /** The chain the step runs on. */
  entry: Entry;
  /** Names the step in the report. */
  action: 'pause' | 'resume';
  /** The chain's part of the pause or resume. */
  step: (entry: Entry) => void;
};

/** What the pool tells its watchers, one listener per watcher. */
type WatchEvent =
  { kind: 'activity'; activity: ChainActivity } | { kind: 'bestBlock'; genesisHash: string; blockNumber: number };

const DEFAULT_DESTROY_DELAY_MS = 60_000;

// Names the pool in its log lines. Lease traffic logs at debug level, so it prints only with VITE_APP_DEBUG.
const POOL_TAG = '[dot.li chain-pool]';

/**
 * A pool that shares one transport per chain among its leases, and closes it `destroyDelay` after the last one.
 *
 * @example
 * const pool = createChainPool({ createTransport: createChainProvider, destroyDelay: 10_000 });
 * const connection = pool.getLocalProvider(genesisHash, { holder: 'balances' })?.(onMessage);
 */
export function createChainPool({ createTransport, destroyDelay = DEFAULT_DESTROY_DELAY_MS }: Params): ChainPool {
  const entries = new Map<string, Entry>();
  // Outlives the entries, so a chain that halts and is rebuilt keeps its warning count.
  const warners = new Map<string, BrokerWarner>();
  const statuses = new Map<string, ConnectionStatus>();
  const listeners = new Map<string, ListenerSet<ConnectionStatus>>();
  let sessionCounter = 0;
  let paused = false;
  const watchers = createListenerSet<WatchEvent>({ onListenerError: reportListener('protocol', 'chain_pool.watch') });

  function getActivity(entry: Entry): ChainActivity {
    return {
      genesisHash: entry.key,
      consumers: entry.live ? entry.leases : 0,
      status: statuses.get(entry.key) ?? 'disconnected',
      following: entry.live && entry.following,
    };
  }

  function report(entry: Entry): void {
    watchers.emit({ kind: 'activity', activity: getActivity(entry) });
  }

  function setStatus(key: string, status: ConnectionStatus): void {
    if (statuses.get(key) === status) {
      return;
    }
    statuses.set(key, status);
    listeners.get(key)?.emit(status);
  }

  /** Close an entry: quietly on release or unload, telling its leases on a halt. */
  function destroy(entry: Entry, halt: { error: unknown } | null): void {
    if (!entry.live) {
      return;
    }
    entry.live = false;
    log.debug(`${POOL_TAG} ${getShortKey(entry.key)} closing`, halt === null ? 'on release or unload' : halt.error);
    // The broker drops it with the other sessions.
    entry.watchFollow = null;
    if (entry.destroyTimer !== null) {
      clearTimeout(entry.destroyTimer);
      entry.destroyTimer = null;
    }
    entries.delete(entry.key);
    // Before the broker call: a halt handler may lease the chain again, and
    // the rebuilt entry's status must not be overwritten afterwards.
    setStatus(entry.key, 'disconnected');
    report(entry);
    // The entry is already gone, so one chain's failure must not keep the others open.
    try {
      if (halt === null) {
        entry.broker.disconnectAll();
      } else {
        entry.broker.halt(halt.error);
      }
    } catch (error) {
      reportDefect(error, {
        flow: 'protocol',
        step: 'chain_pool_close',
        metric: S.CHAIN_POOL_CLOSE,
        message: `${POOL_TAG} closing ${getShortKey(entry.key)} (${halt === null ? 'on release or unload' : 'on a halt'}) failed:`,
      });
    }
  }

  /** Gives a chain's new status to its guard, the pool's statuses and the watchers, and nothing once the chain is closed. */
  function applyStatus(entry: Entry, status: ConnectionStatus): void {
    if (!entry.live) {
      return;
    }
    entry.guard.onStatus(status);
    setStatus(entry.key, status);
    report(entry);
  }

  function pauseEntry(entry: Entry): void {
    entry.pausable.pause();
    // A consumer may release the last lease while it hears the pause, which closes the entry.
    applyStatus(entry, 'disconnected');
  }

  function resumeEntry(entry: Entry): void {
    if (entry.pausable.isPaused()) {
      entry.pausable.resume();
    }
  }

  /** Runs `step` on one chain, and halts the chain when it throws so its leases recover. */
  function haltOnFailure({ entry, action, step }: HaltOnFailureParams): void {
    try {
      step(entry);
    } catch (error) {
      reportDefect(error, {
        flow: 'protocol',
        step: `chain_pool_${action}`,
        metric: S.CHAIN_POOL_CLOSE,
        message: `${POOL_TAG} ${action} of ${getShortKey(entry.key)} failed:`,
      });
      destroy(entry, { error });
    }
  }

  /** The watchers' own follow on a held chain, which reports to them while the entry lives. */
  function openFollow(entry: Entry): { disconnect: () => void } {
    // Names the chain, so the follow's debug log says which one refused it.
    const sessionId = `watch:${getShortKey(entry.key)}:${sessionCounter.toString(36)}`;
    sessionCounter += 1;
    const follow = openWatchFollow({
      sessionId,
      connect: onMessage => entry.broker.connect({ sessionId, onMessage, wireMode: 'object' }),
      live: () => entry.live,
      onFollowing: following => {
        if (entry.live && entry.following !== following) {
          entry.following = following;
          report(entry);
        }
      },
      onBestBlock: blockNumber => {
        if (entry.live) {
          watchers.emit({ kind: 'bestBlock', genesisHash: entry.key, blockNumber });
        }
      },
    });
    return {
      disconnect() {
        follow.disconnect();
        // Reported by whoever stopped it, with the change that stopped it.
        entry.following = false;
      },
    };
  }

  /** The watchers' follow runs exactly while the chain is held and watched. */
  function syncWatchFollow(entry: Entry): void {
    const wanted = entry.live && watchers.size > 0 && entry.leases > 0;
    if (wanted && entry.watchFollow === null) {
      log.debug(`${POOL_TAG} ${getShortKey(entry.key)} held, the network panel follows it`);
      entry.watchFollow = openFollow(entry);
    } else if (!wanted && entry.watchFollow !== null) {
      const watchFollow = entry.watchFollow;
      entry.watchFollow = null;
      log.debug(
        `${POOL_TAG} ${getShortKey(entry.key)} the network panel stops following it (${String(entry.leases)} leases)`,
      );
      watchFollow.disconnect();
    }
  }

  function build(key: string): Entry | null {
    // Null until the transport exists, so a hook that fires earlier has nothing to report on.
    let entry: Entry | null = null;
    const hooks: ChainTransportHooks = {
      onStatus: status => {
        if (entry !== null) {
          applyStatus(entry, status);
        }
      },
      onHalt: error => {
        if (entry?.live === true) {
          destroy(entry, { error });
        }
      },
    };
    const transport = createTransport(key, hooks);
    if (transport === null) {
      return null;
    }
    const pausable = createPausableTransport({ transport });
    if (paused) {
      pausable.pause();
    }
    const guard = createWatchGuard({ transport: pausable.provider });
    const warn = warners.get(key) ?? createBrokerWarner();
    warners.set(key, warn);
    const created: Entry = {
      key,
      pausable,
      guard,
      broker: createChainBroker({ provider: guard.provider, warn }),
      leases: 0,
      destroyTimer: null,
      live: true,
      following: false,
      watchFollow: null,
    };
    log.debug(`${POOL_TAG} ${getShortKey(key)} opening`);
    entry = created;
    entries.set(key, created);
    setStatus(key, pausable.isPaused() ? 'disconnected' : 'connecting');
    report(created);
    return created;
  }

  function acquire(genesisHash: string): Entry | null {
    const key = genesisHash.toLowerCase();
    const entry = entries.get(key) ?? build(key);
    if (entry === null) {
      return null;
    }
    if (!paused) {
      haltOnFailure({ entry, action: 'resume', step: resumeEntry });
    }
    if (entry.destroyTimer !== null) {
      clearTimeout(entry.destroyTimer);
      entry.destroyTimer = null;
    }
    // A chain that failed to reopen is halted, so the lease takes the chain built in its place.
    return entry.live ? entry : (entries.get(key) ?? build(key));
  }

  function idle(entry: Entry): void {
    if (entry.leases > 0 || !entry.live || entry.destroyTimer !== null) {
      return;
    }
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
  function lease<Connection extends { disconnect: () => void }>({
    entry,
    connection,
    holder,
  }: LeaseParams<Connection>): Connection {
    entry.leases += 1;
    log.debug(`${POOL_TAG} ${getShortKey(entry.key)} leased by ${holder} (${String(entry.leases)} held)`);
    report(entry);
    syncWatchFollow(entry);
    let released = false;
    return {
      ...connection,
      disconnect() {
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
        log.debug(`${POOL_TAG} ${getShortKey(entry.key)} released by ${holder} (${String(entry.leases)} held)`);
        // Before the report, so the last release reaches the watchers with the follow already stopped.
        syncWatchFollow(entry);
        report(entry);
        idle(entry);
      },
    };
  }

  return {
    connectRemote({ genesisHash, connectionId, onMessage, onHalt }) {
      const entry = acquire(genesisHash);
      if (entry === null) {
        return null;
      }
      try {
        // Prefixed so no remote id can collide with a local lease's `local:N`.
        return lease({
          entry,
          connection: entry.broker.connect({
            sessionId: `remote:${connectionId}`,
            // On the string wire the broker sends JSON text, which it types as `unknown`.
            onMessage: onMessage as (message: unknown) => void,
            wireMode: 'string',
            onHalt: onHalt ?? null,
          }),
          holder: `remote:${connectionId}`,
        });
      } catch (error) {
        idle(entry);
        throw error;
      }
    },

    getLocalProvider(genesisHash, { holder = 'local' } = {}) {
      const entry = acquire(genesisHash);
      if (entry === null) {
        return null;
      }
      // Callers call the provider at once. One that never does must not keep
      // the entry for good, so its countdown starts once this turn is over.
      queueMicrotask(() => {
        idle(entry);
      });
      function connectLease(
        onMessage: (message: JsonRpcMessage) => void,
        onHalt?: (error?: unknown) => void,
      ): JsonRpcConnection {
        const current = acquire(genesisHash);
        if (current === null) {
          throw new Error(`No chain transport for ${genesisHash}`);
        }
        const sessionId = `local:${sessionCounter.toString(36)}`;
        sessionCounter += 1;
        try {
          // On the object wire the broker passes JSON-RPC messages through, which it types as `unknown`.
          return lease({
            entry: current,
            connection: current.broker.connect({
              sessionId,
              onMessage: onMessage as (message: unknown) => void,
              wireMode: 'object',
              onHalt: onHalt ?? null,
            }),
            holder,
          }) as JsonRpcConnection;
        } catch (error) {
          idle(current);
          throw error;
        }
      }
      return connectLease;
    },

    disconnectAll() {
      for (const entry of [...entries.values()]) {
        destroy(entry, null);
      }
    },

    pause() {
      if (paused) {
        return;
      }
      paused = true;
      const live = [...entries.values()];
      for (const entry of live) {
        haltOnFailure({ entry, action: 'pause', step: pauseEntry });
      }
      log.event(`${POOL_TAG} paused`, { flow: 'protocol', chains: live.length });
    },

    resume() {
      if (!paused) {
        return;
      }
      paused = false;
      const live = [...entries.values()];
      // Each transport reports its own status as it opens, some inside this call, so none is set here.
      for (const entry of live) {
        // A consumer's delivery in this loop may have closed the chain.
        if (entry.live && entry.leases > 0) {
          haltOnFailure({ entry, action: 'resume', step: resumeEntry });
        }
      }
      log.event(`${POOL_TAG} resumed`, { flow: 'protocol', chains: live.length });
    },

    status(genesisHash) {
      return statuses.get(genesisHash.toLowerCase()) ?? 'disconnected';
    },

    onStatusChanged(genesisHash, callback) {
      const key = genesisHash.toLowerCase();
      let callbacks = listeners.get(key);
      if (callbacks === undefined) {
        callbacks = createListenerSet<ConnectionStatus>({
          onListenerError: reportListener('protocol', 'chain_pool.status'),
        });
        listeners.set(key, callbacks);
      }
      return callbacks.subscribe(callback);
    },

    watch(watcher) {
      function hear(event: WatchEvent): void {
        switch (event.kind) {
          case 'activity':
            watcher.onActivity(event.activity);
            return;
          case 'bestBlock':
            watcher.onBestBlock(event.genesisHash, event.blockNumber);
            return;
        }
      }
      function unwatch(): void {
        unsubscribe();
        if (watchers.size === 0) {
          for (const entry of [...entries.values()]) {
            syncWatchFollow(entry);
          }
        }
      }
      const unsubscribe = watchers.subscribe(hear);
      for (const entry of [...entries.values()]) {
        watchers.deliver(hear, { kind: 'activity', activity: getActivity(entry) });
        syncWatchFollow(entry);
      }
      return unwatch;
    },
  };
}

function getShortKey(key: string): string {
  return `${key.slice(0, 10)}…`;
}
