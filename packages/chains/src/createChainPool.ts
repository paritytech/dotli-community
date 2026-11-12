// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Each chain's lanes, shared by every consumer in this JS context. Each lease is a consumer of the chain's lanes, which
// spread the chain's follows over as many connections as its transport's follow limit needs. An entry closes
// `destroyDelay` after its last lease is released, and at once when any lane's transport halts. While someone watches
// the pool, each held chain also carries the watchers' own follow, which is a consumer but not a lease. A follow the
// node refuses is tried again behind a backoff while the chain is held. A pause closes every lane's connection under
// the same leases, and a resume opens them again. A local provider's lease takes the rebuilt chain after a halt, behind
// the pool's redial, and a remote session ends at its chain's halt.

import type { JsonRpcConnection, JsonRpcProvider } from '@polkadot-api/json-rpc-provider';
import type { ChainTransport, ChainTransportHooks, ConnectionStatus } from './transportHooks.js';
import { createReporter } from '@dotli/metrics';
import {
  createListenerSet,
  createStateMachine,
  log,
  nest,
  realTimers,
  type HandlerOf,
  type HandlersOf,
  type ListenerSet,
  type MachineTypes,
  type Timers,
  type Transition,
} from '@dotli/shared';
import type { BrokerConnection } from './brokerMessages.js';
import { createBrokerWarner, type BrokerWarner } from './createBrokerWarner.js';
import { chainLaneOpenMetric } from './chainLaneOpenMetric.js';
import { chainPoolCloseMetric } from './chainPoolCloseMetric.js';
import { createChainLanes, type ChainLanes } from './createChainLanes.js';
import { createChainRedial } from './createChainRedial.js';
import { createHealingLease, type AttachAnswer } from './createHealingLease.js';
import { createRedialGate, type RedialGate } from './createRedialGate.js';
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
  /** Hears the chain's halt once the session is open. */
  onHalt?: (error?: unknown) => void;
};
type GetLocalProviderParams = NonNullable<Parameters<ChainBrokerManager['getLocalProvider']>[1]>;

export type ChainPool = {
  /**
   * Leases the chain for a remote session under `connectionId`, with its messages sent to `onMessage` as JSON text
   * and its later halt to `onHalt`. Returns `null` when this context cannot reach the chain, and throws when
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

/** The watchers' own follow, as it is opened on a chain's lanes. */
type WatchFollow = ReturnType<typeof openWatchFollow>;

/** The chain a watch follows, held by the watch since a watch's handlers see only the watch. */
type WatchChain = {
  lanes: ChainLanes;
  /** Holds back the watchers' follow after the node refuses it. */
  followGate: RedialGate;
};

/** The watchers' own follow on a held chain. */
type Watch =
  | { kind: 'off'; chain: WatchChain }
  | { kind: 'starting'; chain: WatchChain; follow: WatchFollow }
  | { kind: 'open'; chain: WatchChain; follow: WatchFollow; following: boolean }
  | {
      kind: 'refused';
      chain: WatchChain;
      /** Aborted to stop the wait to try the follow again. */
      retry: AbortController;
    };

/** Why a chain closed: its halt, or `null` for a close on release or unload. */
type Halt = { error: unknown } | null;

/**
 * One chain's lanes as the pool holds them. `unheld` has no lease and no countdown, and `expiring` counts down to its
 * close. `closed` stays until the chain is asked for again, so a lease that opened as the chain halted reads the halt.
 * `chain` holds the facts that outlive every kind. The follow gate outlives `held`, so a chain leased again still
 * waits out its backoff.
 */
type Entry = {
  chain: WatchChain & {
    /** Outlives the lanes, so a chain that halts and is rebuilt keeps its warning count. */
    warn: BrokerWarner;
  };
  status: ConnectionStatus;
} & (
  | { kind: 'held'; leases: number; watch: Watch }
  | { kind: 'unheld' }
  | {
      kind: 'expiring';
      /** Aborted to stop the countdown to the chain's close. */
      countdown: AbortController;
    }
  | { kind: 'closed'; halt: Halt }
);

type LiveKind = 'held' | 'unheld' | 'expiring';
type LiveEntry = Extract<Entry, { kind: LiveKind }>;
type UnheldEntry = Extract<Entry, { kind: 'unheld' }>;

type PoolState =
  { kind: 'running'; entries: ReadonlyMap<string, Entry> } | { kind: 'paused'; entries: ReadonlyMap<string, Entry> };

type PoolKind = PoolState['kind'];

/** Each `key` is a chain's lowercase genesis hash, and each `lanes` the lanes the event is about. */
type PoolEvent =
  | { kind: 'chainAsked'; key: string }
  | { kind: 'leased'; key: string; lanes: ChainLanes; holder: string }
  | { kind: 'released'; key: string; lanes: ChainLanes; holder: string }
  | { kind: 'askEnded'; key: string }
  | { kind: 'closeDue'; key: string }
  | { kind: 'laneStatus'; key: string; lanes: ChainLanes; status: ConnectionStatus }
  | { kind: 'laneHalted'; key: string; lanes: ChainLanes; error: unknown }
  | { kind: 'syncDue'; key: string }
  | { kind: 'followChanged'; key: string; follow: WatchFollow; following: boolean }
  | { kind: 'followRefused'; key: string; follow: WatchFollow }
  | { kind: 'bestBlock'; key: string; follow: WatchFollow; blockNumber: number }
  | { kind: 'retryDue'; key: string }
  | { kind: 'followFailed'; key: string; lanes: ChainLanes; error: unknown }
  | { kind: 'modeAsked'; mode: PoolKind }
  | { kind: 'watchersChanged' }
  | { kind: 'closeAsked' };

/** What happened to a chain or the pool. The runner reads the activity from the state the transition left. */
type PoolEffect =
  | { kind: 'status'; key: string; status: ConnectionStatus }
  | { kind: 'activity' | 'built' | 'followed' | 'unfollowed'; key: string }
  | { kind: 'leased' | 'released'; key: string; holder: string }
  | { kind: 'closed'; key: string; halt: Halt }
  | { kind: 'bestBlock'; key: string; blockNumber: number }
  | { kind: 'modeSet'; mode: PoolKind }
  | { kind: 'buildFailed' | 'followFailed'; key: string; error: unknown }
  | { kind: 'startTimer'; timer: AbortController; ms: number; event: PoolEvent }
  | { kind: 'stopTimer'; timer: AbortController }
  | { kind: 'endWatch'; watch: Watch }
  | { kind: 'disconnectLanes'; lanes: ChainLanes };

type PoolMachine = MachineTypes<PoolState, PoolEvent, PoolEffect>;
type EntryMachine = MachineTypes<Entry, PoolEvent, PoolEffect>;
type WatchMachine = MachineTypes<Watch, PoolEvent, PoolEffect>;

/** What the pool tells its watchers, one listener per watcher. */
type WatchEvent =
  { kind: 'activity'; activity: ChainActivity } | { kind: 'bestBlock'; genesisHash: string; blockNumber: number };

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
  destroyDelay = 60_000,
  isFrameDown = () => false,
  timers = realTimers,
}: Params): ChainPool {
  const listeners = new Map<string, ListenerSet<ConnectionStatus>>();
  let sessionCounter = 0;
  const watchers = createListenerSet<WatchEvent>({ onListenerError: protocolReport.listener('chain_pool.watch') });
  const redial = createChainRedial({ status: readStatus, isFrameDown, timers });
  const healingLeases = new Set<JsonRpcConnection>();

  const storeStatus: HandlerOf<EntryMachine, LiveKind, 'laneStatus'> = (
    entry,
    { key, status },
    { emitState, emitSideEffect },
  ) => {
    emitState({ ...entry, status });
    if (entry.status !== status) {
      emitSideEffect({ kind: 'status', key, status });
    }
    emitSideEffect({ kind: 'activity', key });
  };
  const closeOnHalt: HandlerOf<EntryMachine, LiveKind, 'laneHalted'> = (entry, { key, error }, transition) => {
    closeEntry({ key, entry, halt: { error } }, transition);
  };
  const closeQuietly: HandlerOf<EntryMachine, LiveKind, 'closeDue'> = (entry, { key }, transition) => {
    closeEntry({ key, entry, halt: null }, transition);
  };
  // Sent as an event, so a failure that a halt of the chain caused finds the chain closed by that queued halt and goes
  // unreported.
  const reportFollowFailure: HandlerOf<EntryMachine, LiveKind, 'followFailed'> = (
    _entry,
    { key, error },
    { emitSideEffect },
  ) => {
    emitSideEffect({ kind: 'followFailed', key, error });
  };
  const holdEntry: HandlerOf<EntryMachine, 'unheld' | 'expiring', 'leased'> = (
    entry,
    { key, holder },
    { emitState, emitSideEffect, update },
  ) => {
    const { chain, status } = entry;
    emitState({ kind: 'held', chain, status, leases: 1, watch: { kind: 'off', chain } });
    emitSideEffect({ kind: 'leased', key, holder });
    update({ kind: 'syncDue', key });
    if (entry.kind === 'expiring') {
      emitSideEffect({ kind: 'stopTimer', timer: entry.countdown });
    }
  };

  // A watch with no watcher left stops its follow, or its wait to follow again.
  const leaveWhenUnwatched: HandlerOf<WatchMachine, 'starting' | 'open' | 'refused', 'syncDue'> = (
    watch,
    { key },
    { emitState, emitSideEffect },
  ) => {
    if (watchers.size > 0) {
      return;
    }
    emitState({ kind: 'off', chain: watch.chain });
    emitSideEffect({ kind: 'unfollowed', key });
    emitSideEffect({ kind: 'endWatch', watch });
  };

  // The watchers' follow runs exactly while the chain is held and watched.
  const handleWatch = nest<
    EntryMachine,
    'held',
    WatchMachine,
    'syncDue' | 'followChanged' | 'followRefused' | 'bestBlock' | 'retryDue'
  >({
    find({ watch }, event) {
      switch (event.kind) {
        case 'syncDue':
        case 'retryDue':
          return watch;
        case 'followChanged':
        case 'followRefused':
        case 'bestBlock':
          return watch.kind === 'open' && watch.follow === event.follow ? watch : null;
      }
    },
    store: (entry, _event, watch) => ({ ...entry, watch }),
    handlers: {
      off: {
        syncDue({ chain }, { key }, transition) {
          if (watchers.size === 0) {
            return;
          }
          transition.emitSideEffect({ kind: 'followed', key });
          if (chain.followGate.waitMs() > 0) {
            waitToRetry(chain, key, transition);
            return;
          }
          openFollow(chain, key, transition);
        },
      },
      starting: {
        syncDue(watch, event, transition) {
          // The last watcher may have left while the follow opened, such as one that a status change it opened told.
          if (watchers.size === 0) {
            leaveWhenUnwatched(watch, event, transition);
            return;
          }
          // Started here, since a start that throws leaves the watch off.
          try {
            watch.follow.start();
          } catch (error) {
            transition.emitState({ kind: 'off', chain: watch.chain });
            transition.emitSideEffect({ kind: 'endWatch', watch });
            transition.update({ kind: 'followFailed', key: event.key, lanes: watch.chain.lanes, error });
            return;
          }
          transition.emitState({ kind: 'open', chain: watch.chain, follow: watch.follow, following: false });
        },
      },
      open: {
        syncDue: leaveWhenUnwatched,
        followChanged(watch, { key, following }, { emitState, emitSideEffect }) {
          if (watch.following === following) {
            return;
          }
          emitState({ ...watch, following });
          emitSideEffect({ kind: 'activity', key });
        },
        followRefused(watch, { key }, transition) {
          watch.chain.followGate.noteHalt();
          waitToRetry(watch.chain, key, transition);
          transition.emitSideEffect({ kind: 'endWatch', watch });
        },
        bestBlock(_watch, { key, blockNumber }, { emitSideEffect }) {
          emitSideEffect({ kind: 'bestBlock', key, blockNumber });
        },
      },
      refused: {
        // A watcher still here changes nothing, since the backoff is pending.
        syncDue: leaveWhenUnwatched,
        retryDue({ chain }, { key }, transition) {
          // The timer and the gate's clock may disagree, so the follow waits again as the gate says.
          if (!chain.followGate.tryDial()) {
            waitToRetry(chain, key, transition);
            return;
          }
          transition.emitSideEffect({ kind: 'followed', key });
          openFollow(chain, key, transition);
        },
      },
    },
  });

  const handleEntry = nest<
    PoolMachine,
    PoolKind,
    EntryMachine,
    Exclude<PoolEvent['kind'], 'modeAsked' | 'watchersChanged' | 'closeAsked'>
  >({
    find({ entries }, event) {
      const entry = entries.get(event.key) ?? null;
      if (entry === null) {
        return null;
      }
      switch (event.kind) {
        case 'leased':
        case 'released':
        case 'laneStatus':
        case 'laneHalted':
        case 'followFailed':
          return entry.chain.lanes === event.lanes ? entry : null;
        // An ask that ends after a rebuild still counts the rebuilt chain down.
        case 'askEnded':
        case 'chainAsked':
        case 'closeDue':
        case 'syncDue':
        case 'followChanged':
        case 'followRefused':
        case 'bestBlock':
        case 'retryDue':
          return entry;
      }
    },
    store: (state, { key }, entry) => ({ ...state, entries: new Map(state.entries).set(key, entry) }),
    handlers: {
      held: {
        leased(entry, { key, holder }, { emitState, emitSideEffect, update }) {
          emitState({ ...entry, leases: entry.leases + 1 });
          emitSideEffect({ kind: 'leased', key, holder });
          update({ kind: 'syncDue', key });
        },
        released(entry, { key, holder }, transition) {
          transition.emitSideEffect({ kind: 'released', key, holder });
          if (entry.leases > 1) {
            transition.emitState({ ...entry, leases: entry.leases - 1 });
            return;
          }
          const { chain, status } = entry;
          const unheld: UnheldEntry = { kind: 'unheld', chain, status };
          transition.emitState(unheld);
          transition.emitSideEffect({ kind: 'endWatch', watch: entry.watch });
          idle(key, unheld, transition);
        },
        laneStatus: storeStatus,
        laneHalted: closeOnHalt,
        closeDue: closeQuietly,
        followFailed: reportFollowFailure,
        syncDue: handleWatch,
        followChanged: handleWatch,
        followRefused: handleWatch,
        bestBlock: handleWatch,
        retryDue: handleWatch,
      },
      unheld: {
        leased: holdEntry,
        askEnded(entry, { key }, transition) {
          idle(key, entry, transition);
        },
        laneStatus: storeStatus,
        laneHalted: closeOnHalt,
        closeDue: closeQuietly,
        followFailed: reportFollowFailure,
      },
      expiring: {
        chainAsked(entry, _event, { emitState, emitSideEffect }) {
          const { chain, status } = entry;
          emitState({ kind: 'unheld', chain, status });
          emitSideEffect({ kind: 'stopTimer', timer: entry.countdown });
        },
        leased: holdEntry,
        laneStatus: storeStatus,
        laneHalted: closeOnHalt,
        closeDue: closeQuietly,
        followFailed: reportFollowFailure,
      },
      closed: null,
    },
  });

  const poolHandlers: HandlersOf<PoolMachine, PoolKind> = {
    chainAsked(state, event, transition) {
      const { key } = event;
      const asked = state.entries.get(key) ?? null;
      if (asked !== null && isLive(asked)) {
        handleEntry(state, event, transition);
        return;
      }
      const warn = asked?.chain.warn ?? createBrokerWarner();
      let lanes: ChainLanes | null = null;
      try {
        lanes = createChainLanes({
          label: getShortKey(key),
          createTransport: hooks => createTransport(key, hooks),
          warn,
          paused: state.kind === 'paused',
          // Null until the lanes exist, so a hook that fires earlier has nothing to report on.
          onStatus: status => {
            if (lanes !== null) {
              transition.update({ kind: 'laneStatus', key, lanes, status });
            }
          },
          onHalt: error => {
            if (lanes !== null) {
              haltLanes({ kind: 'laneHalted', key, lanes, error });
            }
          },
        });
      } catch (error) {
        transition.emitSideEffect({ kind: 'buildFailed', key, error });
        return;
      }
      if (lanes === null) {
        return;
      }
      const built: Entry = {
        kind: 'unheld',
        chain: { lanes, followGate: createRedialGate({ timers }), warn },
        status: lanes.status(),
      };
      transition.emitState({ ...state, entries: new Map(state.entries).set(key, built) });
      if (asked?.status !== built.status) {
        transition.emitSideEffect({ kind: 'status', key, status: built.status });
      }
      transition.emitSideEffect({ kind: 'built', key });
    },
    modeAsked(state, { mode }, { emitState, emitSideEffect }) {
      if (state.kind === mode) {
        return;
      }
      emitState({ ...state, kind: mode });
      emitSideEffect({ kind: 'modeSet', mode });
    },
    watchersChanged({ entries }, _event, { update }) {
      for (const key of entries.keys()) {
        update({ kind: 'syncDue', key });
      }
    },
    closeAsked({ entries }, _event, { update }) {
      for (const key of entries.keys()) {
        update({ kind: 'closeDue', key });
      }
    },
    leased: handleEntry,
    released: handleEntry,
    askEnded: handleEntry,
    closeDue: handleEntry,
    laneStatus: handleEntry,
    laneHalted: handleEntry,
    syncDue: handleEntry,
    followChanged: handleEntry,
    followRefused: handleEntry,
    bestBlock: handleEntry,
    retryDue: handleEntry,
    followFailed: handleEntry,
  };

  const machine = createStateMachine<PoolMachine>({
    initial: { kind: 'running', entries: new Map() },
    handlers: { running: poolHandlers, paused: poolHandlers },
    onEffect: runEffect,
    onError: error => {
      protocolReport.defect(error, {
        step: 'chain_pool_close',
        metric: chainPoolCloseMetric,
        message: `${POOL_TAG} a transition failed:`,
      });
    },
  });

  return {
    connectRemote({ genesisHash, connectionId, onMessage, onHalt }) {
      // Prefixed so no remote id can collide with a local lease's `local:N`.
      const sessionId = `remote:${connectionId}`;
      const key = genesisHash.toLowerCase();
      const answer = takeLease(key, sessionId, {
        sessionId,
        // On the string wire the broker sends JSON text, which it types as `unknown`.
        onMessage: onMessage as (message: unknown) => void,
        wireMode: 'string',
        onHalt: onHalt ?? null,
      });
      switch (answer.kind) {
        case 'attached':
          return answer.connection;
        case 'unreachable':
          return null;
        case 'halted':
          throw new Error(`chain ${getShortKey(key)} halted while remote session ${connectionId} opened`, {
            cause: answer.error,
          });
      }
    },

    getLocalProvider(genesisHash, { holder = 'local' } = {}) {
      const key = genesisHash.toLowerCase();
      machine.update({ kind: 'chainAsked', key });
      // Callers call the provider at once. One that never does must not keep
      // the entry for good, so its countdown starts once this turn is over.
      machine.update(Promise.resolve<PoolEvent>({ kind: 'askEnded', key }));
      if (findLive(key) === null) {
        return null;
      }
      return onMessage => {
        const connection = createHealingLease({
          key,
          attach: (onLeaseMessage, onHalt) => {
            const sessionId = `local:${sessionCounter.toString(36)}`;
            sessionCounter += 1;
            return takeLease(key, holder, {
              sessionId,
              // On the object wire the broker passes JSON-RPC messages through, which it types as `unknown`.
              onMessage: onLeaseMessage as (message: unknown) => void,
              wireMode: 'object',
              onHalt,
            });
          },
          redial,
          timers,
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
      };
    },

    disconnectAll() {
      // Each lease ends even when an earlier one fails to.
      for (const held of [...healingLeases]) {
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
      machine.update({ kind: 'closeAsked' });
    },

    pause() {
      if (machine.state.get().kind === 'paused') {
        return;
      }
      machine.update({ kind: 'modeAsked', mode: 'paused' });
      // Each chain is read as the loop comes to it, since a consumer that hears an earlier chain may close a later one.
      for (const key of [...machine.state.get().entries.keys()]) {
        const entry = findLive(key);
        if (entry !== null) {
          runOnLanes(key, entry.chain.lanes, 'pause');
        }
      }
    },

    resume() {
      if (machine.state.get().kind === 'running') {
        return;
      }
      machine.update({ kind: 'modeAsked', mode: 'running' });
      // Each transport reports its own status as it opens, some inside this call, so none is set here. Each chain is
      // read as the loop comes to it, since a consumer that hears an earlier chain may close a later one.
      for (const key of [...machine.state.get().entries.keys()]) {
        const entry = machine.state.get().entries.get(key);
        if (entry?.kind === 'held') {
          runOnLanes(key, entry.chain.lanes, 'resume');
        }
      }
    },

    status(genesisHash) {
      return readStatus(genesisHash.toLowerCase());
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
          machine.update({ kind: 'watchersChanged' });
        }
      }
      const unsubscribe = watchers.subscribe(hear);
      for (const [key, entry] of machine.state.get().entries) {
        if (isLive(entry)) {
          watchers.deliver(hear, { kind: 'activity', activity: getActivity(key) });
        }
      }
      machine.update({ kind: 'watchersChanged' });
      return unwatch;
    },
  };

  /** Runs one effect a transition emitted. */
  function runEffect(effect: PoolEffect): void {
    switch (effect.kind) {
      case 'status':
        listeners.get(effect.key)?.emit(effect.status);
        return;
      case 'activity':
        watchers.emit({ kind: 'activity', activity: getActivity(effect.key) });
        return;
      case 'leased':
      case 'released': {
        const activity = getActivity(effect.key);
        const held = `(${String(activity.consumers)} held)`;
        log.debug(`${POOL_TAG} ${getShortKey(effect.key)} ${effect.kind} by ${effect.holder} ${held}`);
        watchers.emit({ kind: 'activity', activity });
        return;
      }
      case 'built':
        log.debug(`${POOL_TAG} ${getShortKey(effect.key)} opening`);
        watchers.emit({ kind: 'activity', activity: getActivity(effect.key) });
        return;
      case 'closed':
        log.debug(
          `${POOL_TAG} ${getShortKey(effect.key)} closing`,
          effect.halt === null ? 'on release or unload' : effect.halt.error,
        );
        watchers.emit({ kind: 'activity', activity: getActivity(effect.key) });
        return;
      case 'followed':
        log.debug(`${POOL_TAG} ${getShortKey(effect.key)} held, the network panel follows it`);
        return;
      case 'unfollowed':
        log.debug(`${POOL_TAG} ${getShortKey(effect.key)} the network panel stops following it`);
        return;
      case 'bestBlock':
        watchers.emit({ kind: 'bestBlock', genesisHash: effect.key, blockNumber: effect.blockNumber });
        return;
      case 'modeSet':
        protocolReport.log.event(`${POOL_TAG} ${effect.mode === 'paused' ? 'paused' : 'resumed'}`, {
          chains: [...machine.state.get().entries.values()].filter(isLive).length,
        });
        return;
      case 'buildFailed':
        protocolReport.defect(effect.error, {
          step: 'chain_lane_build',
          metric: chainLaneOpenMetric,
          message: `${POOL_TAG} building ${getShortKey(effect.key)} failed:`,
        });
        return;
      case 'followFailed':
        protocolReport.defect(effect.error, {
          step: 'chain_pool_watch_follow',
          metric: chainLaneOpenMetric,
          message: `${POOL_TAG} ${getShortKey(effect.key)} the network panel's follow could not open:`,
        });
        return;
      case 'startTimer': {
        const handle = timers.setTimeout(() => {
          machine.update(effect.event);
        }, effect.ms);
        effect.timer.signal.addEventListener('abort', () => {
          timers.clearTimeout(handle);
        });
        return;
      }
      case 'stopTimer':
        effect.timer.abort();
        return;
      case 'endWatch':
        endWatch(effect.watch);
        return;
      case 'disconnectLanes':
        effect.lanes.disconnectAll();
        return;
    }
  }

  function readStatus(key: string): ConnectionStatus {
    return machine.state.get().entries.get(key)?.status ?? 'disconnected';
  }

  function findLive(key: string): LiveEntry | null {
    const entry = machine.state.get().entries.get(key);
    return entry !== undefined && isLive(entry) ? entry : null;
  }

  function getActivity(key: string): ChainActivity {
    const entry = machine.state.get().entries.get(key);
    const status = entry?.status ?? 'disconnected';
    if (entry?.kind !== 'held') {
      return { genesisHash: key, consumers: 0, status, following: false };
    }
    const { watch } = entry;
    return { genesisHash: key, consumers: entry.leases, status, following: watch.kind === 'open' && watch.following };
  }

  /**
   * Closes a live entry, quietly on release or unload, or on its halt. A halt calls no lanes method here, since its
   * lanes are halted only once the entry reads closed.
   */
  function closeEntry(
    { key, entry, halt }: { key: string; entry: LiveEntry; halt: Halt },
    { emitState, emitSideEffect }: Transition<EntryMachine>,
  ): void {
    const { chain, status } = entry;
    emitState({ kind: 'closed', chain, status: 'disconnected', halt });
    if (status !== 'disconnected') {
      emitSideEffect({ kind: 'status', key, status: 'disconnected' });
    }
    emitSideEffect({ kind: 'closed', key, halt });
    if (entry.kind === 'expiring') {
      emitSideEffect({ kind: 'stopTimer', timer: entry.countdown });
    }
    const watch = entry.kind === 'held' ? entry.watch : null;
    if (halt === null) {
      // Each its own effect, so a failure leaves the rest of the chain closed.
      if (watch !== null) {
        emitSideEffect({ kind: 'endWatch', watch });
      }
      emitSideEffect({ kind: 'disconnectLanes', lanes: chain.lanes });
      return;
    }
    // This path disconnects no follow and no lane, so only a refused watch has a timer to stop.
    if (watch?.kind === 'refused') {
      emitSideEffect({ kind: 'endWatch', watch });
    }
  }

  /** Closes an unheld entry at once, keeps it, or counts it down to its close, as `destroyDelay` says. */
  function idle(key: string, entry: UnheldEntry, transition: Transition<EntryMachine>): void {
    if (destroyDelay <= 0) {
      closeEntry({ key, entry, halt: null }, transition);
      return;
    }
    // `setTimeout` clamps a non-finite delay to about 1 ms, which would close the entry at once.
    if (!Number.isFinite(destroyDelay)) {
      return;
    }
    const countdown = new AbortController();
    transition.emitState({ ...entry, kind: 'expiring', countdown });
    transition.emitSideEffect({
      kind: 'startTimer',
      timer: countdown,
      ms: destroyDelay,
      event: { kind: 'closeDue', key },
    });
  }

  /** Stops the watchers' follow, or its wait to follow again. */
  function endWatch(watch: Watch): void {
    switch (watch.kind) {
      case 'off':
        return;
      case 'starting':
      case 'open':
        watch.follow.disconnect();
        return;
      case 'refused':
        watch.retry.abort();
        return;
    }
  }

  /** Holds the watchers' follow as refused until its gate's wait ends. */
  function waitToRetry(chain: WatchChain, key: string, { emitState, emitSideEffect }: Transition<WatchMachine>): void {
    const retry = new AbortController();
    emitState({ kind: 'refused', chain, retry });
    emitSideEffect({
      kind: 'startTimer',
      timer: retry,
      ms: chain.followGate.waitMs(),
      event: { kind: 'retryDue', key },
    });
  }

  /**
   * Opens the watchers' follow and stores it as `starting`, and its sync starts it once this transition ends, so a
   * watcher that leaves meanwhile stops it first. A follow that cannot open leaves the watch off, and the next sync tries
   * again.
   */
  function openFollow(chain: WatchChain, key: string, { emitState, update }: Transition<WatchMachine>): void {
    // Names the chain, so the follow's debug log says which one refused it.
    const sessionId = `watch:${getShortKey(key)}:${sessionCounter.toString(36)}`;
    sessionCounter += 1;
    let follow: WatchFollow;
    try {
      follow = openWatchFollow({
        sessionId,
        connect: onMessage => chain.lanes.connect({ sessionId, onMessage, wireMode: 'object' }),
        // The pool ends a follow by disconnecting it, so a follow the chain stops always follows again.
        live: () => true,
        onFollowing: following => {
          update({ kind: 'followChanged', key, follow, following });
        },
        onRefused: () => {
          update({ kind: 'followRefused', key, follow });
        },
        onBestBlock: blockNumber => {
          update({ kind: 'bestBlock', key, follow, blockNumber });
        },
      });
    } catch (error) {
      emitState({ kind: 'off', chain });
      update({ kind: 'followFailed', key, lanes: chain.lanes, error });
      return;
    }
    emitState({ kind: 'starting', chain, follow });
    update({ kind: 'syncDue', key });
  }

  /**
   * Tells the pool its chain's lanes halted, then halts them once the pool closed the chain, so a lease taken again from
   * inside that halt builds the chain anew. Reports a halt that throws.
   */
  function haltLanes(event: Extract<PoolEvent, { kind: 'laneHalted' }>): void {
    machine.update(event);
    // A halt heard inside a pool transition, such as a follow whose new lane could not be built, waits in the pool's
    // queue, and a lease taken now could not build the chain. Its lanes halt once that transition is done.
    if (findLive(event.key)?.chain.lanes === event.lanes) {
      queueMicrotask(() => {
        haltLanesNow(event);
      });
      return;
    }
    haltLanesNow(event);
  }

  function haltLanesNow({ key, lanes, error: haltError }: Extract<PoolEvent, { kind: 'laneHalted' }>): void {
    try {
      lanes.halt(haltError);
    } catch (error) {
      protocolReport.defect(error, {
        step: 'chain_pool_close',
        metric: chainPoolCloseMetric,
        message: `${POOL_TAG} closing ${getShortKey(key)} (on a halt) failed:`,
      });
    }
  }

  /** Pauses or resumes one chain's lanes, and halts the chain when that throws so its leases recover. */
  function runOnLanes(key: string, lanes: ChainLanes, action: 'pause' | 'resume'): void {
    try {
      lanes[action]();
    } catch (error) {
      protocolReport.defect(error, {
        step: `chain_pool_${action}`,
        metric: chainPoolCloseMetric,
        message: `${POOL_TAG} ${action} of ${getShortKey(key)} failed:`,
      });
      haltLanes({ kind: 'laneHalted', key, lanes, error });
    }
  }

  /**
   * Leases the chain at `key` for one session on its lanes, as the pool holds it once the chain is asked for. Answers
   * `halted` when the chain halted while the session opened, and gives the session's `onHalt` only a later halt.
   * Throws as the lanes' connect throws.
   */
  function takeLease(
    key: string,
    holder: string,
    session: Parameters<ChainLanes['connect']>[0],
  ): AttachAnswer<BrokerConnection> {
    // A chain closed by the pause, and not resumed since no lease held it, opens again under its new lease. Lanes that
    // are not paused ignore the resume.
    const live = findLive(key);
    if (machine.state.get().kind === 'running' && live !== null) {
      runOnLanes(key, live.chain.lanes, 'resume');
    }
    machine.update({ kind: 'chainAsked', key });
    const entry = findLive(key);
    if (entry === null) {
      machine.update({ kind: 'askEnded', key });
      return { kind: 'unreachable' };
    }
    const { lanes } = entry.chain;
    // A halt heard while the session opens goes in the answer.
    let phase: { kind: 'opening'; halt: Halt } | { kind: 'open' } | { kind: 'released' } = {
      kind: 'opening',
      halt: null,
    };
    let connection: BrokerConnection;
    try {
      connection = lanes.connect({
        ...session,
        onHalt: error => {
          switch (phase.kind) {
            case 'opening':
              phase = { kind: 'opening', halt: { error } };
              return;
            case 'open':
              session.onHalt?.(error);
              return;
            case 'released':
              return;
          }
        },
      });
    } catch (error) {
      machine.update({ kind: 'askEnded', key });
      throw error;
    }
    machine.update({ kind: 'leased', key, lanes, holder });
    // A halt while the session opens may not reach it, and a session on a closed chain would never hear one.
    const openingHalt = phase.halt;
    if (openingHalt !== null || findLive(key)?.chain.lanes !== lanes) {
      phase = { kind: 'released' };
      connection.disconnect();
      machine.update({ kind: 'released', key, lanes, holder });
      const closed = machine.state.get().entries.get(key);
      return {
        kind: 'halted',
        error: closed?.kind === 'closed' && closed.chain.lanes === lanes ? closed.halt?.error : openingHalt?.error,
      };
    }
    phase = { kind: 'open' };
    return {
      kind: 'attached',
      connection: {
        send: connection.send,
        disconnect() {
          if (phase.kind !== 'open') {
            return;
          }
          phase = { kind: 'released' };
          connection.disconnect();
          machine.update({ kind: 'released', key, lanes, holder });
        },
      },
    };
  }
}

function isLive(entry: Entry): entry is LiveEntry {
  switch (entry.kind) {
    case 'held':
    case 'unheld':
    case 'expiring':
      return true;
    case 'closed':
      return false;
  }
}

function getShortKey(key: string): string {
  return `${key.slice(0, 10)}…`;
}
