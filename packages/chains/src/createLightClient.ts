// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// One light client per context over truapi-provider's embedded smoldot, shared by the resolver, the broker and every
// product. Each chain comes from its genesis hash through truapi-provider's bundled catalog.

import type { JsonRpcConnection, JsonRpcMessage, JsonRpcRequest } from '@polkadot-api/json-rpc-provider';
import { DEBUG, getChainRoleForGenesis, getActiveSupportedGenesisHashes, type ChainRole } from '@dotli/config/fixed';
import { createReporter, defineCount, m } from '@dotli/metrics';
import {
  createListenerSet,
  createStateMachine,
  getErrorMessage,
  log,
  markHandled,
  nest,
  type HandlerOf,
  type MachineTypes,
  type Transition,
} from '@dotli/shared';
import init, { ChainProviderBuilder, setLogLevel, type Connection } from '@parity/truapi-provider';
import wasmUrl from '@parity/truapi-provider/truapi_provider_bg.wasm?url';
import { createSmoldotDb, type SmoldotDb } from './createSmoldotDb.js';
import {
  pageChainSyncReporter,
  type ChainLifecycleWatch,
  type ChainSyncReporter,
  type ChainSyncTap,
  type ParsedRpcMessage,
} from './createChainSyncReporter.js';
import { LIGHT_CLIENT_FOLLOW_LIMIT, type ChainTransport, type ChainTransportHooks } from './transportHooks.js';

const report = createReporter({ flow: 'protocol' });

/**
 * A light-client connection refused at the light client's connection cap, which halts its chain.
 * Tagged `outcome` (error) and `reason` (`cap`).
 */
const smoldotConnectionCapMetric = defineCount<'error'>('smoldot.connection_cap');

/** A light client transition or effect that threw. Tagged `outcome` (error). */
const lightClientTransitionMetric = defineCount<'error'>('light_client.transition');

/**
 * Liveness heartbeat, the constant `1` once per 60s per light client.
 * Read it with `count_unique(trace)`. Summing counts heartbeats, which scale with the bucket size.
 * A heartbeat because a client dies with its tab or worker and never reports a destroy.
 */
const SMOLDOT_ACTIVE = 'smoldot.active';

// Reached through `loadProvider` too, so a caller that loads the light client lazily keeps sync reporting off its boot path.
export { chainSync } from './createChainSyncReporter.js';

/** What the light client uses of a started truapi-provider. */
export type LightClientEngine = {
  /**
   * Hands the chain its stored database before its first add. Resolves whether there was one, and rejects on a failed
   * read.
   */
  loadDatabase(genesisHash: string): Promise<boolean>;
  /**
   * Adds the chain and opens a JSON-RPC connection to it. Rejects when the chain cannot be added, and with a
   * `LightClientCapError` when the engine already holds as many connections as it allows.
   */
  connect(genesisHash: string): Promise<LightClientConnection>;
  /** Watches the chain's lifecycle snapshots. May throw when the engine offers no watch. */
  lifecycle(genesisHash: string): ChainLifecycleWatch;
};

export type LightClientConnection = Pick<Connection, 'send' | 'close' | 'nextResponse'>;

export type StartEngineParams = {
  /** truapi-provider's log level, `off` for none. */
  logLevel: string;
  /** Read for each chain's first add, and written as it finalizes. */
  store: SmoldotDb | null;
  /** Lets the debug console change the log level. */
  debug: boolean;
};

export type StartEngine = (params: StartEngineParams) => Promise<LightClientEngine>;

export type LightClientDeps = {
  /** Each chain's stored database, or `null` where IndexedDB is missing and every chain starts cold. */
  db: SmoldotDb | null;
  /** truapi-provider's log level, `off` for none. */
  logLevel: string;
  /** Counts this light client as live. `null` where metrics go nowhere, so no timer keeps an idle SharedWorker up. */
  gauge: ((value: number) => void) | null;
  /** The gauge reports at start and then on this interval. */
  heartbeatMs?: number;
  /** Puts the log level on `globalThis.__truapiProvider` for the debug console. */
  debug?: boolean;
  /** Defaults to truapi-provider's wasm. */
  start?: StartEngine;
  /** Defaults to the page's sync reporter. */
  attachChainSync?: ChainSyncReporter['attachChainSync'];
};

// Observed at the store, since the crate reads it for the relay it dials internally. "unavailable" keeps an
// outage apart from cold starts.
export type SmoldotDbChain = Exclude<ChainRole, 'people'>;
export type SmoldotDbOutcome = 'hit' | 'miss' | 'unavailable';

export type LightClientStatus = {
  /** Why no chain can be opened, once one could not. It never clears. */
  readonly fatal: string | null;
  /** Each chain's first read of its stored database. */
  readonly db: ReadonlyMap<SmoldotDbChain, SmoldotDbOutcome>;
};

export type LightClientChange =
  { kind: 'fatal'; message: string } | { kind: 'db'; chain: SmoldotDbChain; outcome: SmoldotDbOutcome };

export type LightClient = {
  /**
   * Returns the chain's transport, which takes the light client's follow limit, or `null` for a genesis the active
   * network does not define. smoldot never reconnects underneath its consumers, so a failure or an unrequested stream
   * end halts the chain. A failure under a connection's `send` or `disconnect` is reported as the light client's defect.
   */
  createChainTransport: (genesisHash: string, hooks?: ChainTransportHooks) => ChainTransport | null;
  /** Whether the active network defines the genesis. */
  isChainSupported: (genesisHash: string) => boolean;
  /** The light client's state now, as a copy. */
  status: () => LightClientStatus;
  /** Hears each change after the call, so a reader that joins late starts from `status()`. */
  subscribe: (listener: (change: LightClientChange) => void) => () => void;
};

const HEARTBEAT_DEFAULT_MS = 60_000;
const LOG_LEVEL_KEY = 'dotli:truapi-provider-log';
const HEARTBEAT_KEY = 'dotli:smoldot-heartbeat-ms';
// truapi-provider rejects a connect past its connection cap with this text.
const CONNECTION_CAP_TEXT = 'the light client already holds';

// What a chain's sync tap needs of its connection and engine.
type ChainSyncSource = Omit<Parameters<ChainSyncReporter['attachChainSync']>[0], 'chain'>;

type CreateChainSyncTapsParams = {
  attachChainSync: ChainSyncReporter['attachChainSync'];
};

// A chain's connected sources in connect order, and the tap one of them holds.
type ChainSyncEntry = {
  sources: Set<ChainSyncSource>;
  held: { source: ChainSyncSource; tap: ChainSyncTap } | null;
};

/** A chain one consumer opened. */
type Chain = {
  /** The lowercase genesis hash, which every engine call takes. */
  genesis: string;
  onMessage: (message: JsonRpcMessage) => void;
  hooks: ChainTransportHooks | null;
};

/** Unique to one opened connection. */
type ConnectionKey = symbol;

// The engine's life. A fatal never clears, so a light client that reached it opens no chain again. `idle` holds no
// connections, since the open that leaves it adds the first. `starter` is the open that started the engine, which hears
// the start's error and names the fatal.
type ClientState =
  | { kind: 'idle' }
  | { kind: 'starting'; starter: { key: ConnectionKey; genesis: string }; connections: Connections }
  | {
      kind: 'running';
      engine: LightClientEngine;
      heartbeat: ReturnType<typeof setInterval> | null;
      connections: Connections;
    }
  | { kind: 'fatal'; message: string; connections: Connections };

type Connections = ReadonlyMap<ConnectionKey, ChainConnection>;

/**
 * One connection's steps. `restoring` and `connecting` hold the engine they work on, so a connection goes on after
 * another chain turned the light client fatal. `closing` left while its connect was in flight. `stopped` halted while
 * it read, and keeps the engine's connection until the consumer leaves. An `ended` connection leaves the map.
 */
type ChainConnection =
  | { kind: 'waiting'; chain: Chain; queued: readonly string[] }
  | { kind: 'restoring'; chain: Chain; engine: LightClientEngine; queued: readonly string[] }
  | { kind: 'connecting'; chain: Chain; engine: LightClientEngine; queued: readonly string[] }
  | { kind: 'closing'; chain: Chain }
  | { kind: 'stopped'; connection: LightClientConnection }
  | { kind: 'reading'; chain: Chain; connection: LightClientConnection; source: ChainSyncSource }
  | { kind: 'ended' };

type ReadingConnection = Extract<ChainConnection, { kind: 'reading' }>;

type ClientEvent =
  | { kind: 'opened'; key: ConnectionKey; chain: Chain }
  | { kind: 'refused'; key: ConnectionKey; message: string }
  | { kind: 'engineStarted'; engine: LightClientEngine }
  | { kind: 'engineFailed'; error: unknown }
  | { kind: 'storeAnswered'; genesis: string; outcome: SmoldotDbOutcome }
  | { kind: 'restored'; key: ConnectionKey; genesis: string; warm: boolean }
  | { kind: 'restoreMissed'; key: ConnectionKey; genesis: string; error: unknown }
  | { kind: 'chainConnected'; key: ConnectionKey; connection: LightClientConnection }
  | { kind: 'connectFailed'; key: ConnectionKey; error: unknown }
  | { kind: 'responseRead'; key: ConnectionKey; message: JsonRpcMessage }
  | { kind: 'streamEnded'; key: ConnectionKey }
  | { kind: 'readFailed'; key: ConnectionKey; error: unknown }
  | { kind: 'sent'; key: ConnectionKey; message: JsonRpcRequest }
  | { kind: 'left'; key: ConnectionKey };

type ClientEffect =
  | { kind: 'ready' }
  | { kind: 'fatal'; message: string }
  | { kind: 'dbRead'; genesis: string; outcome: SmoldotDbOutcome }
  | { kind: 'dbCache'; genesis: string; warm: boolean }
  | { kind: 'warmStartMissed'; genesis: string; error: unknown }
  | { kind: 'capRefused'; error: LightClientCapError; genesis: string }
  | { kind: 'readBroke'; error: unknown; genesis: string }
  | { kind: 'halted'; hooks: ChainTransportHooks | null; error: unknown };

type ClientMachine = MachineTypes<ClientState, ClientEvent, ClientEffect>;

/** One connection's steps, nested in the light client's state. */
type ConnectionMachine = MachineTypes<ChainConnection, ClientEvent, ClientEffect>;

/** A connect the engine refused because it already holds as many connections as it allows. */
export class LightClientCapError extends Error {
  override readonly name = 'LightClientCapError';

  constructor(genesisHash: string, cause: unknown) {
    super(`Light client refused chain ${genesisHash} at its connection cap`, { cause });
  }
}

/**
 * A light client whose engine starts on the first chain it opens. A failed start turns it fatal for good, and a chain
 * opened after a fatal halts without starting the engine.
 *
 * @example
 * const lightClient = createLightClient(createLightClientDeps(null, false)); // no session store, not local
 * const transport = lightClient.createChainTransport(genesisHash); // null for a genesis the network does not define
 */
export function createLightClient({
  db,
  logLevel,
  gauge,
  heartbeatMs = HEARTBEAT_DEFAULT_MS,
  debug = false,
  start = startTruapiProvider,
  attachChainSync = pageChainSyncReporter.attachChainSync,
}: LightClientDeps): LightClient {
  const listeners = createListenerSet<LightClientChange>({
    onListenerError: report.listener('light_client'),
  });
  const dbOutcomes = new Map<SmoldotDbChain, SmoldotDbOutcome>();
  // The read needs no engine, so it overlaps the wasm compile. A blob is megabytes, so an entry lives only until its
  // chain's resume.
  const earlyReads = new Map<string, Promise<string | null>>();
  const syncTaps = createChainSyncTaps({ attachChainSync });

  // A message sent before the chain connects goes out once it does, in order.
  const queueMessage: HandlerOf<ConnectionMachine, 'waiting' | 'restoring' | 'connecting', 'sent'> = (
    state,
    { message },
    { emitState },
  ) => {
    emitState({ ...state, queued: [...state.queued, JSON.stringify(message)] });
  };
  // A connection that leaves before its connect starts never connects.
  const dropConnection: HandlerOf<ConnectionMachine, 'waiting' | 'restoring', 'left'> = (
    _state,
    _event,
    { emitState },
  ) => {
    emitState({ kind: 'ended' });
  };
  // A failed connect is the light client's, except a cap refusal, which is this chain's alone.
  const failConnect: HandlerOf<ClientMachine, 'running' | 'fatal', 'connectFailed'> = (
    state,
    { key, error },
    { emitState, emitSideEffect },
  ) => {
    const connection = state.connections.get(key);
    // Only a connect fails, and a connection that left before it is gone.
    if (connection?.kind !== 'connecting' && connection?.kind !== 'closing') {
      return;
    }
    const { chain } = connection;
    const connections = withConnection(state.connections, key, { kind: 'ended' });
    if (state.kind === 'running' && !(error instanceof LightClientCapError)) {
      const message = `chain ${chain.genesis} connection failed: ${getErrorMessage(error)}`;
      emitState({ kind: 'fatal', message, connections });
      emitSideEffect({ kind: 'fatal', message });
      // A dead light client must not be counted as live.
      if (state.heartbeat !== null) {
        clearInterval(state.heartbeat);
      }
    } else {
      emitState({ ...state, connections });
    }
    if (error instanceof LightClientCapError) {
      emitSideEffect({ kind: 'capRefused', error, genesis: chain.genesis });
    }
    // A connection that left while it connected is never halted.
    if (connection.kind !== 'closing') {
      emitSideEffect({ kind: 'halted', hooks: chain.hooks, error });
    }
  };
  const handleConnection = nest<
    ClientMachine,
    'starting' | 'running' | 'fatal',
    ConnectionMachine,
    | 'refused'
    | 'restored'
    | 'restoreMissed'
    | 'chainConnected'
    | 'responseRead'
    | 'streamEnded'
    | 'readFailed'
    | 'sent'
    | 'left'
  >({
    find: ({ connections }, { key }) => connections.get(key) ?? null,
    store: (state, { key }, next) => ({ ...state, connections: withConnection(state.connections, key, next) }),
    handlers: {
      waiting: {
        refused({ chain }, { message }, { emitState, emitSideEffect }) {
          emitState({ kind: 'ended' });
          emitSideEffect({ kind: 'halted', hooks: chain.hooks, error: new Error(message) });
        },
        sent: queueMessage,
        left: dropConnection,
      },
      restoring: {
        restored(state, { key }, transition) {
          connectChain(state, key, transition);
        },
        // A store that cannot answer starts the chain from the chain-spec checkpoint, as a miss does.
        restoreMissed(state, { key }, transition) {
          connectChain(state, key, transition);
        },
        sent: queueMessage,
        left: dropConnection,
      },
      connecting: {
        chainConnected({ chain, engine, queued }, { key, connection }, transition) {
          const reading: ReadingConnection = {
            kind: 'reading',
            chain,
            connection,
            source: {
              send: raw => {
                connection.send(raw);
              },
              watchLifecycle: () => engine.lifecycle(chain.genesis),
            },
          };
          transition.emitState(reading);
          transition.update(readResponse(key, connection));
          // A send that fails here halts the chain as a consumer's throw does, so it never reads without `connected`.
          try {
            for (const raw of queued) {
              connection.send(raw);
            }
            // After the flush, so the sync request cannot jump ahead of a caller's.
            syncTaps.join(chain.genesis, reading.source);
            chain.hooks?.onStatus('connected');
          } catch (error) {
            breakReading(reading, error, transition);
          }
        },
        sent: queueMessage,
        left({ chain }, _event, { emitState }) {
          emitState({ kind: 'closing', chain });
        },
      },
      closing: {
        chainConnected(_state, { connection }, { emitState }) {
          emitState({ kind: 'ended' });
          connection.close();
        },
      },
      reading: {
        responseRead(state, { key, message }, transition) {
          transition.update(readResponse(key, state.connection));
          try {
            // polkadot-api would reject a string id it never issued.
            if (syncTaps.intercept(state.chain.genesis, state.source, message)) {
              return;
            }
            state.chain.onMessage(message);
          } catch (error) {
            breakReading(state, error, transition);
          }
        },
        // Only the consumer's leave ends the stream in order. Otherwise the transport died or overflowed its send budget.
        streamEnded(state, _event, transition) {
          haltReading(state, new Error(`chain ${state.chain.genesis} stopped responding`), transition);
        },
        readFailed(state, { error }, transition) {
          breakReading(state, error, transition);
        },
        sent({ connection }, { message }) {
          connection.send(JSON.stringify(message));
        },
        left({ chain, connection, source }, _event, { emitState }) {
          emitState({ kind: 'ended' });
          // A tap whose stop throws still leaves the connection closed.
          try {
            syncTaps.leave(chain.genesis, source);
          } finally {
            connection.close();
          }
        },
      },
      stopped: {
        left({ connection }, _event, { emitState }) {
          emitState({ kind: 'ended' });
          connection.close();
        },
      },
      ended: null,
    },
  });
  // The store's answer is the chain's, so it is reported even when the connection left while it restored.
  const resumeChain: HandlerOf<ClientMachine, 'running' | 'fatal', 'restored'> = (state, event, transition) => {
    transition.emitSideEffect({ kind: 'dbCache', genesis: event.genesis, warm: event.warm });
    handleConnection(state, event, transition);
  };
  const resumeChainCold: HandlerOf<ClientMachine, 'running' | 'fatal', 'restoreMissed'> = (
    state,
    event,
    transition,
  ) => {
    transition.emitSideEffect({ kind: 'dbCache', genesis: event.genesis, warm: false });
    transition.emitSideEffect({ kind: 'warmStartMissed', genesis: event.genesis, error: event.error });
    handleConnection(state, event, transition);
  };
  // The engine reads the store from its start on, whatever the light client's phase.
  const noteStoreAnswer: HandlerOf<ClientMachine, 'starting' | 'running' | 'fatal', 'storeAnswered'> = (
    _state,
    { genesis, outcome },
    { emitSideEffect },
  ) => {
    emitSideEffect({ kind: 'dbRead', genesis, outcome });
  };
  const machine = createStateMachine<ClientMachine>({
    initial: { kind: 'idle' },
    handlers: {
      idle: {
        opened(_state, { key, chain }, { emitState, update }) {
          emitState({
            kind: 'starting',
            starter: { key, genesis: chain.genesis },
            connections: new Map<ConnectionKey, ChainConnection>([[key, { kind: 'waiting', chain, queued: [] }]]),
          });
          readEarly(chain.genesis);
          update(
            // A start that throws before it returns a promise rejects this one, so it fails the light client too.
            new Promise<LightClientEngine>(resolve => {
              resolve(start({ logLevel, store: db === null ? null : observeStore(db, update), debug }));
            }).then(
              (engine): ClientEvent => ({ kind: 'engineStarted', engine }),
              (error: unknown): ClientEvent => ({ kind: 'engineFailed', error }),
            ),
          );
        },
      },
      starting: {
        opened(state, { key, chain }, { emitState }) {
          emitState({
            ...state,
            connections: withConnection(state.connections, key, { kind: 'waiting', chain, queued: [] }),
          });
          readEarly(chain.genesis);
        },
        engineStarted({ connections }, { engine }, { emitState, emitSideEffect, update }) {
          // The tick only counts the client as live and changes no phase, so it calls the gauge rather than the machine.
          const heartbeat =
            gauge === null
              ? null
              : setInterval(() => {
                  gauge(1);
                }, heartbeatMs);
          const restoring = new Map<ConnectionKey, Extract<ChainConnection, { kind: 'restoring' }>>();
          for (const [key, connection] of connections) {
            // Narrows the type: every connection of a starting light client waits on the start.
            if (connection.kind !== 'waiting') {
              continue;
            }
            restoring.set(key, { kind: 'restoring', chain: connection.chain, engine, queued: connection.queued });
          }
          emitState({ kind: 'running', engine, heartbeat, connections: restoring });
          // At start, so the first bucket counts a client that is already syncing.
          emitSideEffect({ kind: 'ready' });
          const opened = new Set<string>();
          for (const [key, { chain }] of restoring) {
            opened.add(chain.genesis);
            update(restore(engine, key, chain.genesis));
          }
          // A connection that left while it waited never restores, so its chain's early read goes here.
          for (const genesis of earlyReads.keys()) {
            if (!opened.has(genesis)) {
              earlyReads.delete(genesis);
            }
          }
        },
        engineFailed({ starter, connections }, { error }, { emitState, emitSideEffect }) {
          const message = `chain ${starter.genesis} connection failed: ${getErrorMessage(error)}`;
          emitState({ kind: 'fatal', message, connections: new Map() });
          emitSideEffect({ kind: 'fatal', message });
          for (const [key, connection] of connections) {
            // Narrows the type: every connection of a starting light client waits on the start.
            if (connection.kind !== 'waiting') {
              continue;
            }
            emitSideEffect({
              kind: 'halted',
              hooks: connection.chain.hooks,
              error: key === starter.key ? error : new Error(getRefusal(connection.chain.genesis, message)),
            });
          }
          // A fatal light client reads no store again.
          earlyReads.clear();
        },
        storeAnswered: noteStoreAnswer,
        // A waiting connection only queues and leaves.
        sent: handleConnection,
        left: handleConnection,
      },
      running: {
        opened(state, { key, chain }, { emitState, update }) {
          emitState({
            ...state,
            connections: withConnection(state.connections, key, {
              kind: 'restoring',
              chain,
              engine: state.engine,
              queued: [],
            }),
          });
          update(restore(state.engine, key, chain.genesis));
        },
        connectFailed: failConnect,
        storeAnswered: noteStoreAnswer,
        restored: resumeChain,
        restoreMissed: resumeChainCold,
        // Only a fatal light client refuses an open.
        chainConnected: handleConnection,
        responseRead: handleConnection,
        streamEnded: handleConnection,
        readFailed: handleConnection,
        sent: handleConnection,
        left: handleConnection,
      },
      fatal: {
        opened(state, { key, chain }, { emitState, update }) {
          emitState({
            ...state,
            connections: withConnection(state.connections, key, { kind: 'waiting', chain, queued: [] }),
          });
          // The halt reaches the hooks after the open returns, never inside the call that builds a lane.
          update(
            Promise.resolve<ClientEvent>({ kind: 'refused', key, message: getRefusal(chain.genesis, state.message) }),
          );
        },
        connectFailed: failConnect,
        storeAnswered: noteStoreAnswer,
        restored: resumeChain,
        restoreMissed: resumeChainCold,
        refused: handleConnection,
        chainConnected: handleConnection,
        responseRead: handleConnection,
        streamEnded: handleConnection,
        readFailed: handleConnection,
        sent: handleConnection,
        left: handleConnection,
      },
    },
    onEffect: effect => {
      switch (effect.kind) {
        case 'ready':
          gauge?.(1);
          report.log.event('Light client ready');
          return;
        case 'fatal':
          log.error(`[dot.li provider] ${effect.message}`);
          listeners.emit({ kind: 'fatal', message: effect.message });
          return;
        case 'dbRead': {
          const chain = getChainRoleForGenesis(effect.genesis);
          // First read wins, since only the chain's first add consumes the store. People is left out, as nothing the
          // page waits on depends on it.
          if (chain === null || chain === 'people' || dbOutcomes.has(chain)) {
            return;
          }
          dbOutcomes.set(chain, effect.outcome);
          listeners.emit({ kind: 'db', chain, outcome: effect.outcome });
          return;
        }
        case 'dbCache':
          pageChainSyncReporter.reportDbCache(effect.genesis, effect.warm);
          if (effect.warm) {
            log.debug(`[dot.li provider] resuming ${effect.genesis} from stored state`);
          }
          return;
        case 'warmStartMissed':
          log.warn(`[dot.li provider] warm start unavailable for ${effect.genesis}:`, effect.error);
          return;
        case 'capRefused':
          report.expected(effect.error, {
            step: 'light_client_connect',
            metric: smoldotConnectionCapMetric,
            reason: 'cap',
            message: `[dot.li provider] chain ${effect.genesis} is past the light client's connection cap, halting it: ${getErrorMessage(effect.error)}`,
          });
          return;
        case 'readBroke':
          log.warn(
            `[dot.li provider] chain ${effect.genesis} read failed, halting it: ${getErrorMessage(effect.error)}`,
            effect.error,
          );
          return;
        case 'halted':
          try {
            effect.hooks?.onStatus('disconnected');
            effect.hooks?.onHalt(effect.error);
          } catch (thrown) {
            report.listener('light_client.halt')(thrown);
          }
          return;
      }
    },
    onError: error => {
      report.defect(error, {
        step: 'transition',
        metric: lightClientTransitionMetric,
        message: '[dot.li provider] A light client transition threw',
      });
    },
  });

  return {
    createChainTransport,
    isChainSupported,
    status: () => {
      const state = machine.state.get();
      return { fatal: state.kind === 'fatal' ? state.message : null, db: new Map(dbOutcomes) };
    },
    subscribe: listeners.subscribe,
  };

  /**
   * `store` as the engine reads it, which sends each read's outcome to the machine. The relay's blob is only read here,
   * never through `loadDatabase`. A failure must reject, not read as empty.
   */
  function observeStore(store: SmoldotDb, update: Transition<ClientMachine>['update']): SmoldotDb {
    return {
      async load(genesisHash) {
        try {
          const blob = await readStored(store, genesisHash);
          update({ kind: 'storeAnswered', genesis: genesisHash, outcome: blob !== null ? 'hit' : 'miss' });
          return blob;
        } catch (error) {
          update({ kind: 'storeAnswered', genesis: genesisHash, outcome: 'unavailable' });
          throw error;
        }
      },
      save: (genesisHash, blob) => store.save(genesisHash, blob),
    };
  }

  /** Starts the chain's stored database read, so it overlaps the engine's start. */
  function readEarly(genesis: string): void {
    if (db === null || earlyReads.has(genesis)) {
      return;
    }
    earlyReads.set(genesis, markHandled(db.load(genesis)));
  }

  function readStored(store: SmoldotDb, genesisHash: string): Promise<string | null> {
    const early = earlyReads.get(genesisHash);
    if (early === undefined) {
      return store.load(genesisHash);
    }
    earlyReads.delete(genesisHash);
    return early;
  }

  /** Hands the chain its stored database before its first add, since only a chain's first add consumes a blob. */
  function restore(engine: LightClientEngine, key: ConnectionKey, genesis: string): Promise<ClientEvent> {
    // A load that throws before it returns a promise rejects this one, so the chain starts cold as on a rejection.
    return new Promise<boolean>(resolve => {
      resolve(engine.loadDatabase(genesis));
    })
      .finally(() => {
        earlyReads.delete(genesis);
      })
      .then(
        (warm): ClientEvent => ({ kind: 'restored', key, genesis, warm }),
        (error: unknown): ClientEvent => ({ kind: 'restoreMissed', key, genesis, error }),
      );
  }

  /** Moves a restored connection to `connecting` and starts its connect. */
  function connectChain(
    { chain, engine, queued }: Extract<ChainConnection, { kind: 'restoring' }>,
    key: ConnectionKey,
    { emitState, update }: Transition<ConnectionMachine>,
  ): void {
    emitState({ kind: 'connecting', chain, engine, queued });
    update(
      engine.connect(chain.genesis).then(
        (connection): ClientEvent => ({ kind: 'chainConnected', key, connection }),
        (error: unknown): ClientEvent => ({ kind: 'connectFailed', key, error }),
      ),
    );
  }

  /** Halts a reading chain and hands its sync tap on. The engine's connection stays until the consumer leaves. */
  function haltReading(
    { chain, connection, source }: ReadingConnection,
    error: unknown,
    { emitState, emitSideEffect }: Transition<ConnectionMachine>,
  ): void {
    emitState({ kind: 'stopped', connection });
    emitSideEffect({ kind: 'halted', hooks: chain.hooks, error });
    syncTaps.leave(chain.genesis, source);
  }

  /** Halts a reading chain whose read or consumer failed, with a warning first. */
  function breakReading(reading: ReadingConnection, error: unknown, transition: Transition<ConnectionMachine>): void {
    transition.emitSideEffect({ kind: 'readBroke', error, genesis: reading.chain.genesis });
    haltReading(reading, error, transition);
  }

  function isChainSupported(genesisHash: string): boolean {
    return getActiveSupportedGenesisHashes().has(genesisHash.toLowerCase());
  }

  function createChainTransport(genesisHash: string, hooks?: ChainTransportHooks): ChainTransport | null {
    const genesis = genesisHash.toLowerCase();
    if (!isChainSupported(genesis)) {
      log.warn(`[dot.li provider] Unsupported chain: ${genesisHash}`);
      return null;
    }

    function provider(onMessage: (message: JsonRpcMessage) => void): JsonRpcConnection {
      const key: ConnectionKey = Symbol(genesis);
      hooks?.onStatus('connecting');
      machine.update({ kind: 'opened', key, chain: { genesis, onMessage, hooks: hooks ?? null } });
      return {
        send(message) {
          machine.update({ kind: 'sent', key, message });
        },
        disconnect() {
          machine.update({ kind: 'left', key });
        },
      };
    }
    return { provider, followLimit: LIGHT_CLIENT_FOLLOW_LIMIT };
  }
}

/**
 * The light client a context starts, tuned by its session where it has one (`null` in the SharedWorker). A test raises
 * the log level, or slows the heartbeat so only the startup report lands and the count does not follow wall-clock.
 * `local` on a localhost page, where the light client logs at info.
 */
export function createLightClientDeps(session: Pick<Storage, 'getItem'> | null, local: boolean): LightClientDeps {
  const level = session?.getItem(LOG_LEVEL_KEY) ?? '';
  const heartbeatMs = Number(session?.getItem(HEARTBEAT_KEY) ?? '');
  return {
    db: createSmoldotDb(),
    logLevel: level !== '' ? level : local ? 'info' : 'off',
    gauge: m.enabled
      ? value => {
          m.gauge(SMOLDOT_ACTIVE, value);
        }
      : null,
    ...(Number.isFinite(heartbeatMs) && heartbeatMs > 0 ? { heartbeatMs } : {}),
    debug: DEBUG,
  };
}

/** truapi-provider's wasm, loaded and built once per light client. */
export async function startTruapiProvider({ logLevel, store, debug }: StartEngineParams): Promise<LightClientEngine> {
  await init({ module_or_path: wasmUrl });
  setLogLevel(logLevel);
  if (debug) {
    Reflect.set(globalThis, '__truapiProvider', { setLogLevel });
  }
  const builder = new ChainProviderBuilder();
  // Over https the browser blocks `ws://` to non-localhost peers as mixed content.
  builder.setConnectionTypes({ unsecure: false });
  if (store !== null) {
    builder.setStorage(store);
  }
  return withConnectionCapError(builder.build());
}

/**
 * Wraps `engine` so that a `connect` rejection that states the wasm's connection cap rejects with `LightClientCapError`.
 * Never throws. Any other rejection passes through unchanged. The wasm states its cap only in a rejection's text, so the
 * mapping happens where the failure leaves the wasm.
 */
export function withConnectionCapError(engine: LightClientEngine): LightClientEngine {
  return {
    loadDatabase: genesisHash => engine.loadDatabase(genesisHash),
    lifecycle: genesisHash => engine.lifecycle(genesisHash),
    async connect(genesisHash) {
      try {
        return await engine.connect(genesisHash);
      } catch (error) {
        if (getErrorMessage(error).includes(CONNECTION_CAP_TEXT)) {
          throw new LightClientCapError(genesisHash, error);
        }
        throw error;
      }
    },
  };
}

/**
 * One sync tap per chain, held by one of its connected sources, since every connection of a chain would report the same
 * sync. When the holder leaves, a source still connected takes the tap, so a chain reports its sync while any connection
 * of it is open. Never throws on its own, since `attachChainSync` never throws. A call throws only what the held tap's
 * `stop` or `intercept` throws.
 */
function createChainSyncTaps({ attachChainSync }: CreateChainSyncTapsParams) {
  const entries = new Map<string, ChainSyncEntry>();

  function attach(key: string, entry: ChainSyncEntry, source: ChainSyncSource): void {
    const chain = getChainRoleForGenesis(key);
    if (chain === null) {
      return;
    }
    const tap = attachChainSync({ chain, ...source });
    if (tap !== null) {
      entry.held = { source, tap };
    }
  }

  return {
    /** Adds `source` as connected to the chain, which takes the tap when no source holds it. Never throws. */
    join(key: string, source: ChainSyncSource): void {
      const entry = entries.get(key) ?? { sources: new Set(), held: null };
      entries.set(key, entry);
      entry.sources.add(source);
      if (entry.held === null) {
        attach(key, entry, source);
      }
    },
    /**
     * Removes `source`, and when it held the tap, stops it and attaches one to the next source. A repeat does nothing.
     * Throws only what the stopped tap's `stop` throws, and never from the attach.
     */
    leave(key: string, source: ChainSyncSource): void {
      const entry = entries.get(key);
      if (entry?.sources.delete(source) !== true) {
        return;
      }
      if (entry.sources.size === 0) {
        entries.delete(key);
      }
      if (entry.held?.source !== source) {
        return;
      }
      entry.held.tap.stop();
      entry.held = null;
      const [next] = entry.sources;
      if (next !== undefined) {
        attach(key, entry, next);
      }
    },
    /** Whether `parsed` was the tap's own reply, true only on the source that holds the tap. Throws what the tap throws. */
    intercept(key: string, source: ChainSyncSource, parsed: ParsedRpcMessage): boolean {
      const held = entries.get(key)?.held;
      return held?.source === source && held.tap.intercept(parsed);
    },
  };
}

/** `connections` with the connection of `key` set to `next`, or without it when `next` ended. */
function withConnection(connections: Connections, key: ConnectionKey, next: ChainConnection): Connections {
  const updated = new Map(connections);
  if (next.kind === 'ended') {
    updated.delete(key);
    return updated;
  }
  updated.set(key, next);
  return updated;
}

/** The connection's next response as its event. A rejection, a parse failure included, is a failed read. */
function readResponse(key: ConnectionKey, connection: LightClientConnection): Promise<ClientEvent> {
  return connection
    .nextResponse()
    .then((response): ClientEvent => {
      if (response === undefined) {
        return { kind: 'streamEnded', key };
      }
      // The light client answers only JSON-RPC, which goes on unchecked as the held provider wire.
      return { kind: 'responseRead', key, message: JSON.parse(response) as JsonRpcMessage };
    })
    .catch((error: unknown): ClientEvent => ({ kind: 'readFailed', key, error }));
}

/** Why a chain cannot open on a fatal light client. */
function getRefusal(genesis: string, fatal: string): string {
  return `chain ${genesis} cannot open: the light client is fatal: ${fatal}`;
}
