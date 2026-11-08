// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Each chain's lanes, shared by every consumer in this JS context. Each lease is a consumer of the chain's lanes, which
// spread the chain's follows over as many connections as its transport's follow limit needs. An entry closes
// `destroyDelay` after its last lease is released, and at once when any lane's transport halts. While someone watches
// the pool, each held chain also carries the watchers' own follow, which is a consumer but not a lease. A pause closes
// every lane's connection under the same leases, and a resume opens them again. A local provider's lease takes the
// rebuilt chain after a halt, behind the pool's redial, and a remote session ends at its chain's halt.

import type { JsonRpcConnection, JsonRpcMessage, JsonRpcProvider } from '@polkadot-api/json-rpc-provider';
import type { ChainTransport, ChainTransportHooks, ConnectionStatus } from './transportHooks.js';
import { createReporter } from '@dotli/metrics';
import { createAsyncTaskPool, createListenerSet, log, realTimers, type ListenerSet, type Timers } from '@dotli/shared';
import { createBrokerWarner, type BrokerWarner } from './createBrokerWarner.js';
import { chainLaneOpenMetric } from './chainLaneOpenMetric.js';
import { chainPoolCloseMetric } from './chainPoolCloseMetric.js';
import { createChainLanes, type ChainLanes } from './createChainLanes.js';
import { createChainRedial } from './createChainRedial.js';
import { createHealingLease } from './createHealingLease.js';
import { openWatchFollow } from './openWatchFollow.js';
import type { ChainBrokerManager, StringJsonRpcConnection } from './requireBrokerLocalProvider.js';

const protocolReport = createReporter({ flow: 'protocol' });

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
  createTransport: (genesisHash: string, hooks: ChainTransportHooks) => ChainTransport | null;
  /** How long a chain outlives its last lease, in ms. `Infinity` keeps it. */
  destroyDelay?: number;
  /**
   * For a pool whose transports ride the protocol frame: whether that frame is down, which holds back a lease that
   * halted with it.
   */
  isFrameDown?: () => boolean;
  /** The clock and timers the pool runs on. */
  timers?: Timers;
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
   * `connectionId` already has a session. Throws when the chain halts while the session opens, with the halt's error as
   * the cause.
   */
  connectRemote(params: ConnectRemoteParams): StringJsonRpcConnection | null;
  /**
   * A provider whose connections are leases on the chain that take the rebuilt chain after a halt, or `null` when this
   * context cannot reach it. Calling the provider throws when no transport can be had for the chain at that call.
   * `holder` names the lease in debug logs.
   */
  getLocalProvider(genesisHash: string, params?: GetLocalProviderParams): JsonRpcProvider | null;
  /** The chain's transport status, `disconnected` for a chain the pool does not hold. */
  status(genesisHash: string): ConnectionStatus;
  /** Hears each change of the chain's status, and returns the unsubscribe. */
  onStatusChanged(genesisHash: string, callback: (status: ConnectionStatus) => void): () => void;
  /**
   * Reports each chain's leases, status, follow and best blocks. The chains held now are replayed first. A chain
   * someone holds is followed for its blocks until its last lease is released, and no chain is opened or kept. Never
   * throws.
   */
  watch(watcher: ChainPoolWatcher): () => void;
  /**
   * Ends every healing lease, and closes every chain and its sessions without telling them of a halt. Never throws, and
   * reports a lease or a chain that fails to close.
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

/** What a pool's owner may tell it from outside: pause and resume. */
export type ChainPoolControl = Pick<ChainPool, 'pause' | 'resume'>;

/** The watchers' own follow on an open entry. */
type WatchState = { kind: 'off' } | { kind: 'open'; follow: { disconnect: () => void }; following: boolean };

/** An entry's live phase, written in place. Only `destroy` replaces it, so callbacks compare it by identity. */
type OpenEntry = {
  kind: 'open';
  /** The pending destroy's timer handle, `null` while none is pending. */
  destroyTimer: unknown;
  watch: WatchState;
};

type EntryState =
  | OpenEntry
  | {
      kind: 'closed';
      /** Why the entry halted, for a lease that took it as it halted and so missed the halt. `null` otherwise. */
      halt: { error: unknown } | null;
    };

type Entry = {
  readonly key: string;
  readonly lanes: ChainLanes;
  leases: number;
  state: EntryState;
};

type LeaseParams<Connection> = {
  /** The chain the lease holds. */
  entry: Entry;
  /** The broker session the lease wraps. */
  connection: Connection;
  /** Names the lease in debug logs. */
  holder: string;
};

type AttachLocalParams = {
  /** The chain to lease. */
  genesisHash: string;
  /** Names the lease in debug logs. */
  holder: string;
  /** Hears the lease's messages. */
  onMessage: (message: JsonRpcMessage) => void;
  /** Hears the chain's halt, including one that came while the lease was taken. */
  onHalt: (error?: unknown) => void;
};

type ConnectHealingParams = {
  /** The chain, lowercase. */
  key: string;
  /** Names the lease in debug logs. */
  holder: string;
  /** Hears every message of every lease the healing lease takes. */
  onMessage: (message: JsonRpcMessage) => void;
};

type HaltOnFailureParams = {
  /** The chain to pause or resume. */
  entry: Entry;
  /** What to do to its lanes, which also names the step in the report. */
  action: 'pause' | 'resume';
};

/** What the pool tells its watchers, one listener per watcher. */
type WatchEvent =
  { kind: 'activity'; activity: ChainActivity } | { kind: 'bestBlock'; genesisHash: string; blockNumber: number };

const DEFAULT_DESTROY_DELAY_MS = 60_000;

// Names the pool in its log lines. Lease traffic logs at debug level, so it prints only with VITE_APP_DEBUG.
const POOL_TAG = '[dot.li chain-pool]';

/**
 * A pool that shares each chain's lanes among its leases, and closes them `destroyDelay` after the last one.
 *
 * @example
 * const pool = createChainPool({ createTransport: createChainTransport, destroyDelay: 10_000 });
 * const connection = pool.getLocalProvider(genesisHash, { holder: 'balances' })?.(onMessage);
 */
export function createChainPool({
  createTransport,
  destroyDelay = DEFAULT_DESTROY_DELAY_MS,
  isFrameDown = () => false,
  timers = realTimers,
}: Params): ChainPool {
  const entries = new Map<string, Entry>();
  // Outlives the entries, so a chain that halts and is rebuilt keeps its warning count.
  const warners = new Map<string, BrokerWarner>();
  const statuses = new Map<string, ConnectionStatus>();
  const listeners = new Map<string, ListenerSet<ConnectionStatus>>();
  let sessionCounter = 0;
  let healCounter = 0;
  let paused = false;
  const watchers = createListenerSet<WatchEvent>({ onListenerError: protocolReport.listener('chain_pool.watch') });
  const redial = createChainRedial({ status: key => statuses.get(key) ?? 'disconnected', isFrameDown, timers });
  const waits = createAsyncTaskPool({ poolSize: 1, timers });
  const healingLeases = new Set<JsonRpcConnection>();

  function getActivity(entry: Entry): ChainActivity {
    return {
      genesisHash: entry.key,
      consumers: entry.state.kind === 'open' ? entry.leases : 0,
      status: statuses.get(entry.key) ?? 'disconnected',
      following: isFollowing(entry.state),
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
    const open = entry.state;
    if (open.kind !== 'open') {
      return;
    }
    // Leaves the watchers' follow open. The lanes drop it with the other consumers.
    entry.state = { kind: 'closed', halt };
    if (open.destroyTimer !== null) {
      timers.clearTimeout(open.destroyTimer);
    }
    log.debug(`${POOL_TAG} ${getShortKey(entry.key)} closing`, halt === null ? 'on release or unload' : halt.error);
    entries.delete(entry.key);
    // Before the lanes call: a halt handler may lease the chain again, and
    // the rebuilt entry's status must not be overwritten afterwards.
    setStatus(entry.key, 'disconnected');
    report(entry);
    // The entry is already gone, so one chain's failure must not keep the others open.
    try {
      if (halt === null) {
        entry.lanes.disconnectAll();
      } else {
        entry.lanes.halt(halt.error);
      }
    } catch (error) {
      protocolReport.defect(error, {
        step: 'chain_pool_close',
        metric: chainPoolCloseMetric,
        message: `${POOL_TAG} closing ${getShortKey(entry.key)} (${halt === null ? 'on release or unload' : 'on a halt'}) failed:`,
      });
    }
  }

  /** Gives a chain's new status to the pool's statuses and the watchers, and nothing once the chain is closed. */
  function applyStatus(entry: Entry, status: ConnectionStatus): void {
    if (entry.state.kind !== 'open') {
      return;
    }
    setStatus(entry.key, status);
    report(entry);
  }

  /** Pauses or resumes one chain's lanes, and halts the chain when that throws so its leases recover. */
  function haltOnFailure({ entry, action }: HaltOnFailureParams): void {
    try {
      entry.lanes[action]();
    } catch (error) {
      protocolReport.defect(error, {
        step: `chain_pool_${action}`,
        metric: chainPoolCloseMetric,
        message: `${POOL_TAG} ${action} of ${getShortKey(entry.key)} failed:`,
      });
      destroy(entry, { error });
    }
  }

  /**
   * The watchers' own follow on a held chain, which reports to them while `open` is the entry's state and the follow is
   * its watch.
   */
  function openFollow(entry: Entry, open: OpenEntry): ReturnType<typeof openWatchFollow> {
    // Names the chain, so the follow's debug log says which one refused it.
    const sessionId = `watch:${getShortKey(entry.key)}:${sessionCounter.toString(36)}`;
    sessionCounter += 1;
    // Its callbacks run only after `start`, so `follow` is assigned by then.
    const follow = openWatchFollow({
      sessionId,
      connect: onMessage => entry.lanes.connect({ sessionId, onMessage, wireMode: 'object' }),
      live: () => entry.state.kind === 'open',
      onFollowing: following => {
        const watch = findOwnWatch();
        if (watch !== null && watch.following !== following) {
          watch.following = following;
          report(entry);
        }
      },
      onRefused: () => {
        const watch = findOwnWatch();
        if (watch !== null) {
          open.watch = { kind: 'off' };
          watch.follow.disconnect();
        }
      },
      onBestBlock: blockNumber => {
        if (findOwnWatch() !== null) {
          watchers.emit({ kind: 'bestBlock', genesisHash: entry.key, blockNumber });
        }
      },
    });
    function findOwnWatch(): Extract<WatchState, { kind: 'open' }> | null {
      const { watch } = open;
      return entry.state === open && watch.kind === 'open' && watch.follow === follow ? watch : null;
    }
    return follow;
  }

  /**
   * Opens the watchers' follow under `open`, stores it, then sends it. A failure leaves the chain without one, and the
   * next sync tries again. Never throws.
   */
  function startWatchFollow(entry: Entry, open: OpenEntry): void {
    const off = open.watch;
    let follow: ReturnType<typeof openWatchFollow>;
    try {
      follow = openFollow(entry, open);
    } catch (error) {
      reportWatchFollowFailure(entry, error);
      return;
    }
    // Opening the follow's connection may have halted the chain, or a watcher it reported to may have changed the want.
    if (entry.state !== open || open.watch !== off) {
      follow.disconnect();
      return;
    }
    const watch: WatchState = { kind: 'open', follow, following: false };
    open.watch = watch;
    try {
      follow.start();
    } catch (error) {
      if (open.watch === watch) {
        open.watch = { kind: 'off' };
        follow.disconnect();
      }
      reportWatchFollowFailure(entry, error);
    }
  }

  /** The follow has no caller to throw to. A halted chain tells its leases itself, so only an open chain reports. */
  function reportWatchFollowFailure(entry: Entry, error: unknown): void {
    if (entry.state.kind !== 'open') {
      return;
    }
    protocolReport.defect(error, {
      step: 'chain_pool_watch_follow',
      metric: chainLaneOpenMetric,
      message: `${POOL_TAG} ${getShortKey(entry.key)} the network panel's follow could not open:`,
    });
  }

  /** The watchers' follow runs exactly while the chain is held and watched. */
  function syncWatchFollow(entry: Entry): void {
    const open = entry.state;
    if (open.kind !== 'open') {
      return;
    }
    const wanted = watchers.size > 0 && entry.leases > 0;
    const { watch } = open;
    if (wanted && watch.kind === 'off') {
      log.debug(`${POOL_TAG} ${getShortKey(entry.key)} held, the network panel follows it`);
      startWatchFollow(entry, open);
    } else if (!wanted && watch.kind === 'open') {
      open.watch = { kind: 'off' };
      log.debug(
        `${POOL_TAG} ${getShortKey(entry.key)} the network panel stops following it (${String(entry.leases)} leases)`,
      );
      watch.follow.disconnect();
    }
  }

  function build(key: string): Entry | null {
    // Null until the lanes exist, so a hook that fires earlier has nothing to report on.
    let entry: Entry | null = null;
    const warn = warners.get(key) ?? createBrokerWarner();
    const lanes = createChainLanes({
      label: getShortKey(key),
      createTransport: hooks => createTransport(key, hooks),
      warn,
      paused,
      onStatus: status => {
        if (entry !== null) {
          applyStatus(entry, status);
        }
      },
      onHalt: error => {
        if (entry?.state.kind === 'open') {
          destroy(entry, { error });
        }
      },
    });
    if (lanes === null) {
      return null;
    }
    warners.set(key, warn);
    const created: Entry = {
      key,
      lanes,
      leases: 0,
      state: { kind: 'open', destroyTimer: null, watch: { kind: 'off' } },
    };
    log.debug(`${POOL_TAG} ${getShortKey(key)} opening`);
    entry = created;
    entries.set(key, created);
    setStatus(key, lanes.status());
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
      haltOnFailure({ entry, action: 'resume' });
    }
    const { state } = entry;
    // A chain that failed to reopen is halted, so the lease takes the chain built in its place.
    if (state.kind !== 'open') {
      return entries.get(key) ?? build(key);
    }
    if (state.destroyTimer !== null) {
      timers.clearTimeout(state.destroyTimer);
      state.destroyTimer = null;
    }
    return entry;
  }

  function idle(entry: Entry): void {
    const open = entry.state;
    if (entry.leases > 0 || open.kind !== 'open' || open.destroyTimer !== null) {
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
    open.destroyTimer = timers.setTimeout(() => {
      open.destroyTimer = null;
      destroy(entry, null);
    }, destroyDelay);
  }

  /**
   * Count `connection` as a lease on `entry`, released once by its first `disconnect()`. A lease on a closed entry is not
   * counted, and its `disconnect()` still acts once.
   */
  function lease<Connection extends { disconnect: () => void }>({
    entry,
    connection,
    holder,
  }: LeaseParams<Connection>): Connection {
    if (entry.state.kind === 'open') {
      entry.leases += 1;
      log.debug(`${POOL_TAG} ${getShortKey(entry.key)} leased by ${holder} (${String(entry.leases)} held)`);
      report(entry);
      syncWatchFollow(entry);
    }
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
        if (entry.state.kind !== 'open') {
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

  /** Takes the chain for a local provider, and lets it go idle once its caller has had this turn to connect. */
  function acquireForProvider(genesisHash: string): Entry | null {
    const entry = acquire(genesisHash);
    if (entry === null) {
      return null;
    }
    // Callers call the provider at once. One that never does must not keep
    // the entry for good, so its countdown starts once this turn is over.
    queueMicrotask(() => {
      idle(entry);
    });
    return entry;
  }

  /**
   * A healing lease's attach: leases the chain as the pool holds it now, on the object wire. Returns `null` when no
   * transport can be had, and throws as the chain's connect throws.
   */
  function attachLocal({ genesisHash, holder, onMessage, onHalt }: AttachLocalParams): JsonRpcConnection | null {
    const entry = acquire(genesisHash);
    if (entry === null) {
      return null;
    }
    const sessionId = `local:${sessionCounter.toString(36)}`;
    sessionCounter += 1;
    let connection: JsonRpcConnection;
    try {
      // On the object wire the broker passes JSON-RPC messages through, which it types as `unknown`.
      connection = lease({
        entry,
        connection: entry.lanes.connect({
          sessionId,
          onMessage: onMessage as (message: unknown) => void,
          wireMode: 'object',
          onHalt,
        }),
        holder,
      }) as JsonRpcConnection;
    } catch (error) {
      idle(entry);
      throw error;
    }
    // A halt while the lease is taken may not reach it, so a lease on an entry that is no longer live hears it here.
    const { state } = entry;
    if (state.kind === 'closed') {
      onHalt(state.halt?.error);
    }
    return connection;
  }

  /** A healing lease on `key`, which `disconnectAll` ends while it is held. */
  function connectHealing({ key, holder, onMessage }: ConnectHealingParams): JsonRpcConnection {
    healCounter += 1;
    const connection = createHealingLease({
      key,
      attach: (onLeaseMessage, onHalt) => attachLocal({ genesisHash: key, holder, onMessage: onLeaseMessage, onHalt }),
      redial,
      waits,
      waitPool: `chain_heal:${String(healCounter)}`,
      logTag: POOL_TAG,
      holder,
      onMessage,
    });
    const held: JsonRpcConnection = {
      send: connection.send,
      disconnect() {
        healingLeases.delete(held);
        connection.disconnect();
      },
    };
    healingLeases.add(held);
    return held;
  }

  /** Ends a healing lease for `disconnectAll`, which goes on with the others when one fails. */
  function endHealing(held: JsonRpcConnection): void {
    try {
      held.disconnect();
    } catch (error) {
      protocolReport.defect(error, {
        step: 'chain_pool_close',
        metric: chainPoolCloseMetric,
        message: `${POOL_TAG} ending a healing lease failed:`,
      });
    }
  }

  return {
    connectRemote({ genesisHash, connectionId, onMessage, onHalt }) {
      const entry = acquire(genesisHash);
      if (entry === null) {
        return null;
      }
      let connection: StringJsonRpcConnection;
      try {
        // Prefixed so no remote id can collide with a local lease's `local:N`.
        connection = lease({
          entry,
          connection: entry.lanes.connect({
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
      // A halt while the session opens may not reach it, and a session on a closed chain would never hear one.
      const { state } = entry;
      if (state.kind === 'closed') {
        connection.disconnect();
        throw new Error(`chain ${getShortKey(entry.key)} halted while remote session ${connectionId} opened`, {
          cause: state.halt?.error,
        });
      }
      return connection;
    },

    getLocalProvider(genesisHash, { holder = 'local' } = {}) {
      const entry = acquireForProvider(genesisHash);
      if (entry === null) {
        return null;
      }
      const { key } = entry;
      return onMessage => connectHealing({ key, holder, onMessage });
    },

    disconnectAll() {
      for (const held of [...healingLeases]) {
        endHealing(held);
      }
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
        haltOnFailure({ entry, action: 'pause' });
      }
      protocolReport.log.event(`${POOL_TAG} paused`, { chains: live.length });
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
        if (entry.state.kind === 'open' && entry.leases > 0) {
          haltOnFailure({ entry, action: 'resume' });
        }
      }
      protocolReport.log.event(`${POOL_TAG} resumed`, { chains: live.length });
    },

    status(genesisHash) {
      return statuses.get(genesisHash.toLowerCase()) ?? 'disconnected';
    },

    onStatusChanged(genesisHash, callback) {
      const key = genesisHash.toLowerCase();
      let callbacks = listeners.get(key);
      if (callbacks === undefined) {
        callbacks = createListenerSet<ConnectionStatus>({
          onListenerError: protocolReport.listener('chain_pool.status'),
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

function isFollowing(state: EntryState): boolean {
  switch (state.kind) {
    case 'open':
      return state.watch.kind === 'open' && state.watch.following;
    case 'closed':
      return false;
  }
}

function getShortKey(key: string): string {
  return `${key.slice(0, 10)}…`;
}
