// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The chain and name methods, for every mode. A scope holds one tab's chain connections and budget, while the chains
// themselves are shared by every scope of the engine.

import type { ChainPool, StringJsonRpcConnection } from '@dotli/chains';
import { createReporter, defineCount } from '@dotli/metrics';
import type { ProtocolContext, ProtocolHandler, protocolSchema } from '@dotli/protocol';
import { createStateMachine, nest, type HandlerOf, type MachineTypes } from '@dotli/shared';
import { ok, type MethodTypes } from '@dotli/transport';

import { assertNonEmpty } from './assertNonEmpty.js';
import { createNameReads, type EngineResolver } from './createNameReads.js';
import { PROTOCOL_APP_ERRORS } from './errors.js';

const report = createReporter({ flow: 'protocol' });
const engineTransitionMetric = defineCount<'error'>('protocol.engine.transition');

type ChainSink = Parameters<ProtocolHandler<Methods['chain']['connect']>>[2];

/** One tab's chain connections and budget. */
export type EngineScope = ReturnType<ProtocolEngine['openScope']>;

/** The chain and name methods, with the chains every scope shares. */
export type ProtocolEngine = ReturnType<typeof createEngine>;

export type EngineParams = {
  /** The chains every scope connects to. `dispose` releases them. */
  pool: ChainPool;
  /** Whether a scope may connect to the chain. */
  isChainSupported: (genesisHash: string) => boolean;
  /** Runs on each warmup call, which answers once it settles and rejects with what it rejects with. */
  onWarmup?: () => Promise<void>;
  /** Breadcrumbs for each connection's first answer, halt and close. */
  log?: (message: string) => void;
  /** The name reads. Unset, each read is refused at once instead of leaving the caller to hang. */
  resolver?: EngineResolver;
  /** Caps each read's sync budget, for a tester who needs a timeout to show quickly. */
  syncBudgetCapMs?: number | undefined;
};

type Held = { connection: StringJsonRpcConnection; sink: ChainSink };

/**
 * `answered` has heard its first message. Only the first is noted, later ones would push the load's steps out of the
 * breadcrumb trail.
 */
type Connection = ({ kind: 'connected' } & Held) | ({ kind: 'answered' } & Held) | { kind: 'gone' };

type LiveConnection = Exclude<Connection, { kind: 'gone' }>;

/**
 * Each tab's live connections by scope id, then by connection id. A scope with none leaves the map, and its next
 * connection adds it again.
 */
type Scopes = ReadonlyMap<string, ReadonlyMap<string, LiveConnection>>;

type EngineState = { kind: 'open'; scopes: Scopes } | { kind: 'disposed' };

type ConnectionEvent = { scopeId: string; connectionId: string };

type EngineEvent =
  | ({ kind: 'connected'; connection: StringJsonRpcConnection; sink: ChainSink } & ConnectionEvent)
  | ({ kind: 'messaged'; message: string } & ConnectionEvent)
  | ({ kind: 'halted' } & ConnectionEvent)
  | ({ kind: 'disconnected' } & ConnectionEvent)
  | { kind: 'scopeClosed'; scopeId: string }
  | { kind: 'disposed' };

type EngineEffect =
  | { kind: 'sent'; sink: ChainSink; value: MethodTypes<Methods['chain']['connect']>['receive'] }
  | { kind: 'chainConnected'; connectionId: string }
  | { kind: 'firstMessage'; connectionId: string; bytes: number }
  | { kind: 'chainHalted'; connectionId: string }
  | { kind: 'chainDisconnected'; connectionId: string }
  | { kind: 'disconnect'; connection: StringJsonRpcConnection }
  | { kind: 'sinkEnded'; sink: ChainSink }
  | { kind: 'poolReleased' };

type EngineMachine = MachineTypes<EngineState, EngineEvent, EngineEffect>;

type ConnectionMachine = MachineTypes<Connection, EngineEvent, EngineEffect>;

type Methods = typeof protocolSchema.sections;

/** One scope's budget, which is one tab's. */
export const MAX_CONNECTIONS = 10;

/** The chain and name methods over `pool`, whose scopes share its chains. Never throws. */
export function createEngine({
  pool,
  isChainSupported,
  onWarmup,
  log = (): void => undefined,
  resolver,
  syncBudgetCapMs,
}: EngineParams) {
  // The pool's session ids are engine-wide, so each scope prefixes its own.
  let scopeCount = 0;
  const endConnection: HandlerOf<ConnectionMachine, 'connected' | 'answered', 'halted'> = (
    { sink },
    { connectionId },
    { emitState, emitSideEffect },
  ) => {
    // The broker has already answered pending requests and stopped follows, so there is nothing to disconnect.
    emitState({ kind: 'gone' });
    emitSideEffect({ kind: 'chainHalted', connectionId });
    emitSideEffect({ kind: 'sinkEnded', sink });
  };
  const disconnectConnection: HandlerOf<ConnectionMachine, 'connected' | 'answered', 'disconnected'> = (
    { connection },
    { connectionId },
    { emitState, emitSideEffect },
  ) => {
    emitState({ kind: 'gone' });
    emitSideEffect({ kind: 'disconnect', connection });
    emitSideEffect({ kind: 'chainDisconnected', connectionId });
  };
  const handleConnection = nest<EngineMachine, 'open', ConnectionMachine, 'messaged' | 'halted' | 'disconnected'>({
    find: ({ scopes }, { scopeId, connectionId }) => scopes.get(scopeId)?.get(connectionId) ?? null,
    store: (state, { scopeId, connectionId }, next) => ({
      ...state,
      scopes: withConnection(state.scopes, { scopeId, connectionId }, next),
    }),
    handlers: {
      connected: {
        messaged(held, { connectionId, message }, { emitState, emitSideEffect }) {
          emitState({ ...held, kind: 'answered' });
          emitSideEffect({ kind: 'sent', sink: held.sink, value: { tag: 'message', value: message } });
          emitSideEffect({ kind: 'firstMessage', connectionId, bytes: message.length });
        },
        halted: endConnection,
        disconnected: disconnectConnection,
      },
      answered: {
        messaged({ sink }, { message }, { emitSideEffect }) {
          emitSideEffect({ kind: 'sent', sink, value: { tag: 'message', value: message } });
        },
        halted: endConnection,
        disconnected: disconnectConnection,
      },
      gone: null,
    },
  });
  const machine = createStateMachine<EngineMachine>({
    initial: { kind: 'open', scopes: new Map() },
    handlers: {
      open: {
        connected(state, { scopeId, connectionId, connection, sink }, { emitState, emitSideEffect }) {
          const scopes = withConnection(
            state.scopes,
            { scopeId, connectionId },
            { kind: 'connected', connection, sink },
          );
          emitState({ ...state, scopes });
          emitSideEffect({ kind: 'chainConnected', connectionId });
          emitSideEffect({ kind: 'sent', sink, value: { tag: 'connected', value: undefined } });
        },
        messaged: handleConnection,
        halted: handleConnection,
        disconnected: handleConnection,
        scopeClosed(state, { scopeId }, { emitState, emitSideEffect }) {
          const connections = state.scopes.get(scopeId);
          if (connections === undefined) {
            return;
          }
          const scopes = new Map(state.scopes);
          scopes.delete(scopeId);
          emitState({ ...state, scopes });
          for (const { connection, sink } of connections.values()) {
            emitSideEffect({ kind: 'disconnect', connection });
            emitSideEffect({ kind: 'sinkEnded', sink });
          }
        },
        disposed(state, _event, { emitState, emitSideEffect }) {
          emitState({ kind: 'disposed' });
          for (const connections of state.scopes.values()) {
            for (const { connection } of connections.values()) {
              emitSideEffect({ kind: 'disconnect', connection });
            }
          }
          emitSideEffect({ kind: 'poolReleased' });
        },
      },
      disposed: null,
    },
    onEffect: effect => {
      switch (effect.kind) {
        case 'sent':
          effect.sink.send(effect.value);
          break;
        case 'chainConnected':
          log(`Chain connected: ${effect.connectionId} (${String(countConnections(machine.state.get()))} total)`);
          break;
        case 'firstMessage':
          log(`First chain message for ${effect.connectionId} (${String(effect.bytes)} bytes)`);
          break;
        case 'chainHalted':
          log(`Chain halted: ${effect.connectionId} (${String(countConnections(machine.state.get()))} remaining)`);
          break;
        case 'chainDisconnected':
          log(
            `Chain disconnected: ${effect.connectionId} (${String(countConnections(machine.state.get()))} remaining)`,
          );
          break;
        case 'disconnect':
          effect.connection.disconnect();
          break;
        case 'sinkEnded':
          effect.sink.interrupt(ok());
          break;
        case 'poolReleased':
          pool.disconnectAll();
          break;
      }
    },
    onError: error => {
      report.defect(error, {
        step: 'transition',
        metric: engineTransitionMetric,
        message: '[dot.li] A transition of the engine failed:',
      });
    },
  });

  return {
    /** A new tab's scope, with its own chain connections and budget. Never throws. */
    openScope,
    /** Answers once the mode's warmup settles. Rejects with what the warmup rejects with. */
    warmup,
    ...createNameReads({ resolver, syncBudgetCapMs }),
    /**
     * Disconnects every scope's connections and releases the pool's chains, and every later connect is refused. A
     * repeated call does nothing. Reports a connection's disconnect that throws, and still runs the others and the
     * release. The pool reports what closing a chain throws.
     */
    dispose,
  };

  function dispose(): void {
    machine.update({ kind: 'disposed' });
  }

  function openScope() {
    const scopeId = String(scopeCount++);

    return {
      /**
       * Opens a chain connection for the subscription. Stopping it disconnects it, and a chain halt ends it cleanly.
       * Throws once the engine was disposed, on an empty or reused id, past `MAX_CONNECTIONS`, on an unsupported
       * chain, or when the pool cannot connect.
       */
      connect,
      /** Sends `message` on the connection. Throws on an empty field or an unknown connection. */
      send,
      /**
       * Ends each connection's subscription cleanly and releases it. The scope stays usable. Reports a connection's
       * disconnect that throws, and still releases the others.
       */
      close,
    };

    function close(): void {
      machine.update({ kind: 'scopeClosed', scopeId });
    }

    function connect(
      { genesisHash, connectionId }: MethodTypes<Methods['chain']['connect']>['start'],
      _context: ProtocolContext,
      sink: ChainSink,
    ): () => void {
      const state = machine.state.get();
      if (state.kind === 'disposed') {
        throw new Error('The engine was disposed');
      }
      assertNonEmpty(genesisHash, 'genesisHash');
      assertNonEmpty(connectionId, 'connectionId');
      // Connection ids are unique only within a scope, so each scope checks its own.
      const connections: ReadonlyMap<string, unknown> = state.scopes.get(scopeId) ?? new Map();
      if (connections.has(connectionId)) {
        throw new Error(`Duplicate chain connection: ${connectionId}`);
      }
      if (connections.size >= MAX_CONNECTIONS) {
        throw new Error(`Connection limit reached (max ${String(MAX_CONNECTIONS)})`);
      }
      if (!isChainSupported(genesisHash)) {
        throw new Error(`Unsupported chain: ${genesisHash}`);
      }
      const connection = pool.connectRemote({
        genesisHash,
        connectionId: `${scopeId} ${connectionId}`,
        onMessage: message => {
          machine.update({ kind: 'messaged', scopeId, connectionId, message });
        },
        onHalt: () => {
          machine.update({ kind: 'halted', scopeId, connectionId });
        },
      });
      if (connection === null) {
        throw new Error(PROTOCOL_APP_ERRORS.CHAIN_BROKER_FAILED);
      }
      machine.update({ kind: 'connected', scopeId, connectionId, connection, sink });
      return () => {
        machine.update({ kind: 'disconnected', scopeId, connectionId });
      };
    }

    // Typed as the protocol's handler answers, so the scope's type is no narrower than the method it serves.
    function send(
      { connectionId, message }: MethodTypes<Methods['chain']['send']>['request'],
      _context: ProtocolContext,
    ): ReturnType<ProtocolHandler<Methods['chain']['send']>> {
      assertNonEmpty(connectionId, 'connectionId');
      assertNonEmpty(message, 'message');
      const state = machine.state.get();
      const held = state.kind === 'open' ? state.scopes.get(scopeId)?.get(connectionId) : undefined;
      if (held === undefined) {
        throw new Error(`Unknown chain connection: ${connectionId}`);
      }
      held.connection.send(message);
      return ok();
    }
  }

  // Takes the context and returns what the protocol's handler returns, so the type is no narrower than the method.
  function warmup(
    _request: MethodTypes<Methods['frame']['warmup']>['request'],
    _context: ProtocolContext,
  ): ReturnType<ProtocolHandler<Methods['frame']['warmup']>> {
    return (onWarmup?.() ?? Promise.resolve()).then(() => ok());
  }
}

/** The live connections across every scope. */
function countConnections(state: EngineState): number {
  switch (state.kind) {
    case 'open': {
      let total = 0;
      for (const connections of state.scopes.values()) {
        total += connections.size;
      }
      return total;
    }
    case 'disposed':
      return 0;
  }
}

/** `scopes` with the connection set to `next`, or dropped when `next` is gone, and a scope left empty dropped too. */
function withConnection(
  scopes: Scopes,
  { scopeId, connectionId }: { scopeId: string; connectionId: string },
  next: Connection,
): Scopes {
  const connections = new Map(scopes.get(scopeId));
  switch (next.kind) {
    case 'connected':
    case 'answered':
      connections.set(connectionId, next);
      break;
    case 'gone':
      connections.delete(connectionId);
      break;
  }
  const nextScopes = new Map(scopes);
  if (connections.size === 0) {
    nextScopes.delete(scopeId);
  } else {
    nextScopes.set(scopeId, connections);
  }
  return nextScopes;
}
