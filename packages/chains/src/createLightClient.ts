// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// One light client per context, shared by the resolver, the broker and every product.

import type { JsonRpcConnection, JsonRpcMessage, JsonRpcRequest } from '@polkadot-api/json-rpc-provider';
import { getActiveSupportedGenesisHashes } from '@dotli/config/fixed';
import { createReporter, defineCount } from '@dotli/metrics';
import {
  createListenerSet,
  createStateMachine,
  getErrorMessage,
  log,
  nest,
  type HandlerOf,
  type MachineTypes,
  type Transition,
} from '@dotli/shared';
import { pageChainSyncReporter, type ChainSyncReporter } from './createChainSyncReporter.js';
import { createChainSyncTaps } from './createChainSyncTaps.js';
import { createPrefetchingStore, type SmoldotDbChain, type SmoldotDbOutcome } from './createPrefetchingStore.js';
import type { SmoldotDb } from './createSmoldotDb.js';
import { LIGHT_CLIENT_FOLLOW_LIMIT, type ChainTransport, type ChainTransportHooks } from './transportHooks.js';
import {
  LightClientCapError,
  startTruapiProvider,
  type LightClientConnection,
  type LightClientEngine,
  type StartEngine,
} from './startTruapiProvider.js';

const report = createReporter({ flow: 'protocol' });

/**
 * A light-client connection refused at the light client's connection cap, which halts its chain.
 * Tagged `outcome` (error) and `reason` (`cap`).
 */
const smoldotConnectionCapMetric = defineCount<'error'>('smoldot.connection_cap');

/** A light client transition or effect that threw. Tagged `outcome` (error). */
const lightClientTransitionMetric = defineCount<'error'>('light_client.transition');

// Reached through `loadProvider` too, so a caller that loads the light client lazily keeps these off its boot path.
export { chainSync } from './createChainSyncReporter.js';
export { createLightClientDeps } from './createLightClientDeps.js';

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
// connections, since the open that leaves it adds the first. `starting` names the open that started the engine, which
// hears the start's error and names the fatal. `running` beats until `heartbeat` aborts.
type ClientState =
  | { kind: 'idle' }
  | { kind: 'starting'; starter: { key: ConnectionKey; genesis: string }; connections: Connections }
  | { kind: 'running'; engine: LightClientEngine; heartbeat: AbortController; connections: Connections }
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
  | { kind: 'reading'; chain: Chain; connection: LightClientConnection; engine: LightClientEngine }
  | { kind: 'ended' };

type RestoringConnection = Extract<ChainConnection, { kind: 'restoring' }>;

/** What a chain's stored database gave its restore. A store that cannot answer starts the chain cold, as a miss does. */
type StoredRead = { kind: 'warm' } | { kind: 'cold' } | { kind: 'missed'; error: unknown };
type ReadingConnection = Extract<ChainConnection, { kind: 'reading' }>;

type ClientEvent =
  | { kind: 'opened'; key: ConnectionKey; chain: Chain }
  | { kind: 'refused'; key: ConnectionKey; message: string }
  | { kind: 'engineStarted'; engine: LightClientEngine }
  | { kind: 'engineFailed'; error: unknown }
  | { kind: 'restored'; key: ConnectionKey; genesis: string; read: StoredRead }
  | { kind: 'chainConnected'; key: ConnectionKey; connection: LightClientConnection }
  | { kind: 'connectFailed'; key: ConnectionKey; error: unknown }
  | { kind: 'responseRead'; key: ConnectionKey; message: JsonRpcMessage }
  | { kind: 'streamEnded'; key: ConnectionKey }
  | { kind: 'readFailed'; key: ConnectionKey; error: unknown }
  | { kind: 'sent'; key: ConnectionKey; message: JsonRpcRequest }
  | { kind: 'left'; key: ConnectionKey };

type ClientEffect =
  | { kind: 'ready'; heartbeat: AbortController }
  | { kind: 'fatal'; message: string }
  | { kind: 'stopHeartbeat'; heartbeat: AbortController }
  | { kind: 'prefetch'; genesis: string }
  | { kind: 'keepPrefetches'; genesis: ReadonlySet<string> }
  | { kind: 'chainRestored'; genesis: string; read: StoredRead }
  | { kind: 'send'; connection: LightClientConnection; raw: string }
  | { kind: 'close'; connection: LightClientConnection }
  | { kind: 'leaveSync'; key: ConnectionKey; genesis: string }
  | { kind: 'capRefused'; error: LightClientCapError; genesis: string }
  | { kind: 'readBroke'; error: unknown; genesis: string }
  | { kind: 'halted'; hooks: ChainTransportHooks | null; error: unknown };

type ClientMachine = MachineTypes<ClientState, ClientEvent, ClientEffect>;

/** One connection's steps, nested in the light client's state. */
type ConnectionMachine = MachineTypes<ChainConnection, ClientEvent, ClientEffect>;

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
  const prefetching =
    db === null
      ? null
      : createPrefetchingStore({
          db,
          onFirstRead: (chain, outcome) => {
            listeners.emit({ kind: 'db', chain, outcome });
          },
        });
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
    // Narrows the type: only a connecting connection, or one that left while it connected, waits on a connect.
    if (connection?.kind !== 'connecting' && connection?.kind !== 'closing') {
      return;
    }
    const { chain } = connection;
    const connections = withConnection(state.connections, key, { kind: 'ended' });
    if (error instanceof LightClientCapError) {
      emitState({ ...state, connections });
      emitSideEffect({ kind: 'capRefused', error, genesis: chain.genesis });
    } else if (state.kind === 'running') {
      const message = `chain ${chain.genesis} connection failed: ${getErrorMessage(error)}`;
      emitState({ kind: 'fatal', message, connections });
      emitSideEffect({ kind: 'fatal', message });
      // A dead light client must not be counted as live.
      emitSideEffect({ kind: 'stopHeartbeat', heartbeat: state.heartbeat });
    } else {
      emitState({ ...state, connections });
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
    'refused' | 'restored' | 'chainConnected' | 'responseRead' | 'streamEnded' | 'readFailed' | 'sent' | 'left'
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
        restored: connectChain,
        sent: queueMessage,
        left: dropConnection,
      },
      connecting: {
        chainConnected({ chain, engine, queued }, { key, connection }, { emitState, update }) {
          emitState({ kind: 'reading', chain, connection, engine });
          update(readResponse(key, connection));
          // A send that fails here halts the chain as a consumer's throw does, so it never reads without `connected`.
          try {
            for (const raw of queued) {
              connection.send(raw);
            }
            // After the flush, so the sync request cannot jump ahead of a caller's.
            syncTaps.join(chain.genesis, key, {
              send: raw => {
                connection.send(raw);
              },
              watchLifecycle: () => engine.lifecycle(chain.genesis),
            });
            chain.hooks?.onStatus('connected');
          } catch (error) {
            update({ kind: 'readFailed', key, error });
          }
        },
        sent: queueMessage,
        left({ chain }, _event, { emitState }) {
          emitState({ kind: 'closing', chain });
        },
      },
      closing: {
        chainConnected(_state, { connection }, { emitState, emitSideEffect }) {
          emitState({ kind: 'ended' });
          emitSideEffect({ kind: 'close', connection });
        },
      },
      reading: {
        responseRead({ chain, connection }, { key, message }, { update }) {
          update(readResponse(key, connection));
          try {
            // polkadot-api would reject a string id it never issued.
            if (!syncTaps.intercept(chain.genesis, key, message)) {
              chain.onMessage(message);
            }
          } catch (error) {
            update({ kind: 'readFailed', key, error });
          }
        },
        // Only the consumer's leave ends the stream in order. Otherwise the transport died or overflowed its send budget.
        streamEnded(state, { key }, transition) {
          haltReading(state, { key, error: new Error(`chain ${state.chain.genesis} stopped responding`) }, transition);
        },
        readFailed(state, { key, error }, transition) {
          transition.emitSideEffect({ kind: 'readBroke', error, genesis: state.chain.genesis });
          haltReading(state, { key, error }, transition);
        },
        sent({ connection }, { message }, { emitSideEffect }) {
          emitSideEffect({ kind: 'send', connection, raw: JSON.stringify(message) });
        },
        left(state, { key }, { emitState, emitSideEffect }) {
          emitState({ kind: 'ended' });
          emitSideEffect({ kind: 'leaveSync', key, genesis: state.chain.genesis });
          emitSideEffect({ kind: 'close', connection: state.connection });
        },
      },
      stopped: {
        left({ connection }, _event, { emitState, emitSideEffect }) {
          emitState({ kind: 'ended' });
          emitSideEffect({ kind: 'close', connection });
        },
      },
      ended: null,
    },
  });
  // The store's answer is the chain's, so it is reported even when the connection left while it restored.
  const resumeChain: HandlerOf<ClientMachine, 'running' | 'fatal', 'restored'> = (state, event, transition) => {
    transition.emitSideEffect({ kind: 'chainRestored', genesis: event.genesis, read: event.read });
    handleConnection(state, event, transition);
  };
  const machine = createStateMachine<ClientMachine>({
    initial: { kind: 'idle' },
    handlers: {
      idle: {
        opened(_state, { key, chain }, { emitState, emitSideEffect, update }) {
          emitState({
            kind: 'starting',
            starter: { key, genesis: chain.genesis },
            connections: new Map<ConnectionKey, ChainConnection>([[key, { kind: 'waiting', chain, queued: [] }]]),
          });
          emitSideEffect({ kind: 'prefetch', genesis: chain.genesis });
          update(
            // A start that throws before it returns a promise rejects this one, so it fails the light client too.
            new Promise<LightClientEngine>(resolve => {
              resolve(start({ logLevel, store: prefetching?.store ?? null, debug }));
            }).then(
              (engine): ClientEvent => ({ kind: 'engineStarted', engine }),
              (error: unknown): ClientEvent => ({ kind: 'engineFailed', error }),
            ),
          );
        },
      },
      starting: {
        opened(state, { key, chain }, { emitState, emitSideEffect }) {
          emitState({
            ...state,
            connections: withConnection(state.connections, key, { kind: 'waiting', chain, queued: [] }),
          });
          emitSideEffect({ kind: 'prefetch', genesis: chain.genesis });
        },
        engineStarted({ connections }, { engine }, { emitState, emitSideEffect, update }) {
          const restoring = new Map<ConnectionKey, RestoringConnection>();
          for (const [key, connection] of connections) {
            // Narrows the type: every connection of a starting light client waits on the start.
            if (connection.kind === 'waiting') {
              restoring.set(key, { kind: 'restoring', chain: connection.chain, engine, queued: connection.queued });
            }
          }
          const heartbeat = new AbortController();
          emitState({ kind: 'running', engine, heartbeat, connections: restoring });
          // At start, so the first bucket counts a client that is already syncing.
          emitSideEffect({ kind: 'ready', heartbeat });
          const opened = new Set<string>();
          for (const [key, { chain }] of restoring) {
            opened.add(chain.genesis);
            update(restore(engine, key, chain.genesis));
          }
          // A connection that left while it waited never restores, so its chain's early read goes here.
          emitSideEffect({ kind: 'keepPrefetches', genesis: opened });
        },
        engineFailed({ starter, connections }, { error }, { emitState, emitSideEffect }) {
          const message = `chain ${starter.genesis} connection failed: ${getErrorMessage(error)}`;
          emitState({ kind: 'fatal', message, connections: new Map() });
          emitSideEffect({ kind: 'fatal', message });
          for (const [key, connection] of connections) {
            // Narrows the type: every connection of a starting light client waits on the start.
            if (connection.kind === 'waiting') {
              emitSideEffect({
                kind: 'halted',
                hooks: connection.chain.hooks,
                error: key === starter.key ? error : new Error(getRefusal(connection.chain.genesis, message)),
              });
            }
          }
          // A fatal light client reads no store again.
          emitSideEffect({ kind: 'keepPrefetches', genesis: new Set() });
        },
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
        restored: resumeChain,
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
        restored: resumeChain,
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
        case 'ready': {
          report.log.event('Light client ready');
          if (gauge === null) {
            return;
          }
          gauge(1);
          const beat = setInterval(() => {
            gauge(1);
          }, heartbeatMs);
          effect.heartbeat.signal.addEventListener('abort', () => {
            clearInterval(beat);
          });
          return;
        }
        case 'fatal':
          log.error(`[dot.li provider] ${effect.message}`);
          listeners.emit({ kind: 'fatal', message: effect.message });
          return;
        case 'stopHeartbeat':
          effect.heartbeat.abort();
          return;
        case 'prefetch':
          prefetching?.prefetch(effect.genesis);
          return;
        case 'keepPrefetches':
          prefetching?.keepOnly(effect.genesis);
          return;
        case 'chainRestored': {
          const { genesis, read } = effect;
          // A blob is megabytes, so a chain's early read lives only until its restore.
          prefetching?.drop(genesis);
          pageChainSyncReporter.reportDbCache(genesis, read.kind === 'warm');
          if (read.kind === 'warm') {
            log.debug(`[dot.li provider] resuming ${genesis} from stored state`);
          }
          if (read.kind === 'missed') {
            log.warn(`[dot.li provider] warm start unavailable for ${genesis}:`, read.error);
          }
          return;
        }
        case 'send':
          effect.connection.send(effect.raw);
          return;
        case 'close':
          effect.connection.close();
          return;
        case 'leaveSync':
          syncTaps.leave(effect.genesis, effect.key);
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
            `[dot.li provider] chain ${effect.genesis} failed, halting it: ${getErrorMessage(effect.error)}`,
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
      return { fatal: state.kind === 'fatal' ? state.message : null, db: prefetching?.getFirstReads() ?? new Map() };
    },
    subscribe: listeners.subscribe,
  };

  /** Moves a restored connection to `connecting` and starts its connect. */
  function connectChain(
    { chain, engine, queued }: RestoringConnection,
    { key }: { key: ConnectionKey },
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
    { chain, connection }: ReadingConnection,
    { key, error }: { key: ConnectionKey; error: unknown },
    { emitState, emitSideEffect }: Transition<ConnectionMachine>,
  ): void {
    emitState({ kind: 'stopped', connection });
    emitSideEffect({ kind: 'halted', hooks: chain.hooks, error });
    emitSideEffect({ kind: 'leaveSync', key, genesis: chain.genesis });
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

/** Hands the chain its stored database before its first add, since only a chain's first add consumes a blob. */
function restore(engine: LightClientEngine, key: ConnectionKey, genesis: string): Promise<ClientEvent> {
  // A load that throws before it returns a promise rejects this one, so the chain starts cold as on a rejection.
  return new Promise<boolean>(resolve => {
    resolve(engine.loadDatabase(genesis));
  }).then(
    (warm): ClientEvent => ({ kind: 'restored', key, genesis, read: { kind: warm ? 'warm' : 'cold' } }),
    (error: unknown): ClientEvent => ({ kind: 'restored', key, genesis, read: { kind: 'missed', error } }),
  );
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
