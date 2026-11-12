// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The chain and name methods, for every mode. A scope holds one tab's chain connections and budget, while the chains
// themselves are shared by every scope of the engine.

import type { ChainPool, StringJsonRpcConnection } from '@dotli/chains';
import { TIMEOUTS } from '@dotli/config';
import { createReporter, defineCount } from '@dotli/metrics';
import {
  getBudget,
  type ProtocolContext,
  type ProtocolHandler,
  protocolSchema,
  type RemoteFailure,
  toRemoteEnd,
} from '@dotli/protocol';
import type { DotnsResolver } from '@dotli/resolver';
import { createStateMachine, nest, toError, type HandlerOf, type MachineTypes } from '@dotli/shared';
import { err, ok, type AnyMethod, type CallError, type MethodTypes, type ResultPayload } from '@dotli/transport';

import { PROTOCOL_APP_ERRORS } from './errors.js';

const report = createReporter({ flow: 'protocol' });
const engineTransitionMetric = defineCount<'error'>('protocol.engine.transition');

type ChainSink = Parameters<ProtocolHandler<typeof methods.chain.connect>>[2];

type NameSink = Parameters<ProtocolHandler<typeof methods.resolve.dotName>>[2];

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

export type EngineResolver = Pick<
  DotnsResolver,
  'resolveDotName' | 'resolveOwner' | 'resolveExecutableManifest' | 'resolveRootManifest'
>;

/** `token` tells this connection apart from an earlier one under its id, whose halt can still arrive. */
type Held = { token: symbol; connection: StringJsonRpcConnection; sink: ChainSink };

/**
 * `answered` has heard its first message. Only the first is noted, later ones would push the load's steps out of the
 * breadcrumb trail.
 */
type Connection = ({ kind: 'connected' } & Held) | ({ kind: 'answered' } & Held) | { kind: 'gone' };

/** One tab's live connections. A scope with none leaves the map, and its next connection adds it again. */
type Scope = { kind: 'open'; connections: ReadonlyMap<string, Exclude<Connection, { kind: 'gone' }>> };

type EngineState = { kind: 'open'; scopes: ReadonlyMap<string, Scope> } | { kind: 'disposed' };

type ConnectionEvent = { scopeId: string; connectionId: string; token: symbol };

type EngineEvent =
  | ({ kind: 'connected'; connection: StringJsonRpcConnection; sink: ChainSink } & ConnectionEvent)
  | ({ kind: 'answered'; bytes: number } & ConnectionEvent)
  | ({ kind: 'halted' } & ConnectionEvent)
  | ({ kind: 'disconnected' } & ConnectionEvent)
  | { kind: 'scopeClosed'; scopeId: string }
  | { kind: 'disposed' };

type EngineEffect =
  | { kind: 'chainConnected'; connectionId: string }
  | { kind: 'firstMessage'; connectionId: string; bytes: number }
  | { kind: 'chainHalted'; connectionId: string }
  | { kind: 'chainDisconnected'; connectionId: string }
  | { kind: 'disconnect'; connection: StringJsonRpcConnection }
  | { kind: 'sinkEnded'; sink: ChainSink }
  | { kind: 'poolReleased' };

type EngineMachine = MachineTypes<EngineState, EngineEvent, EngineEffect>;

type ScopeMachine = MachineTypes<Scope, EngineEvent, EngineEffect>;

type ConnectionMachine = MachineTypes<Connection, EngineEvent, EngineEffect>;

const methods = protocolSchema.sections;

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
  const handleConnection = nest<ScopeMachine, 'open', ConnectionMachine, 'answered' | 'halted' | 'disconnected'>({
    find({ connections }, { connectionId, token }) {
      const held = connections.get(connectionId);
      // An event of an earlier connection under a reused id is not for this one.
      return held?.token === token ? held : null;
    },
    store(scope, { connectionId }, next) {
      const connections = new Map(scope.connections);
      switch (next.kind) {
        case 'connected':
        case 'answered':
          connections.set(connectionId, next);
          break;
        case 'gone':
          connections.delete(connectionId);
          break;
      }
      return { ...scope, connections };
    },
    handlers: {
      connected: {
        answered(held, { connectionId, bytes }, { emitState, emitSideEffect }) {
          emitState({ ...held, kind: 'answered' });
          emitSideEffect({ kind: 'firstMessage', connectionId, bytes });
        },
        halted: endConnection,
        disconnected: disconnectConnection,
      },
      answered: {
        halted: endConnection,
        disconnected: disconnectConnection,
      },
      gone: null,
    },
  });
  const handleScope = nest<EngineMachine, 'open', ScopeMachine, 'answered' | 'halted' | 'disconnected'>({
    find: ({ scopes }, { scopeId }) => scopes.get(scopeId) ?? null,
    store(state, { scopeId }, next) {
      const scopes = new Map(state.scopes);
      if (next.connections.size === 0) {
        scopes.delete(scopeId);
      } else {
        scopes.set(scopeId, next);
      }
      return { ...state, scopes };
    },
    handlers: {
      open: { answered: handleConnection, halted: handleConnection, disconnected: handleConnection },
    },
  });
  const machine = createStateMachine<EngineMachine>({
    initial: { kind: 'open', scopes: new Map() },
    handlers: {
      open: {
        connected(state, { scopeId, connectionId, token, connection, sink }, { emitState, emitSideEffect }) {
          const connections = new Map(state.scopes.get(scopeId)?.connections).set(connectionId, {
            kind: 'connected',
            token,
            connection,
            sink,
          });
          emitState({ ...state, scopes: new Map(state.scopes).set(scopeId, { kind: 'open', connections }) });
          emitSideEffect({ kind: 'chainConnected', connectionId });
        },
        answered: handleScope,
        halted: handleScope,
        disconnected: handleScope,
        scopeClosed(state, { scopeId }, { emitState, emitSideEffect }) {
          const scope = state.scopes.get(scopeId);
          if (scope === undefined) {
            return;
          }
          // Dropped first, so a halt the disconnect causes finds nothing to end again.
          const scopes = new Map(state.scopes);
          scopes.delete(scopeId);
          emitState({ ...state, scopes });
          for (const { connection, sink } of scope.connections.values()) {
            emitSideEffect({ kind: 'disconnect', connection });
            emitSideEffect({ kind: 'sinkEnded', sink });
          }
        },
        disposed(state, _event, { emitState, emitSideEffect }) {
          emitState({ kind: 'disposed' });
          for (const { connections } of state.scopes.values()) {
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
    /**
     * Sends each phase, then the result, then ends cleanly, or ends with the read's failure. Throws when the mode
     * resolves no names or `label` is empty.
     */
    resolveDotName,
    /** Answers the name's owner, or the failure as a remote error, a mode that resolves no names included. */
    resolveOwner,
    /**
     * Answers the name's executable manifest, or the failure as a remote error, a mode that resolves no names
     * included.
     */
    resolveExecutableManifest,
    /** Answers the name's root manifest, or the failure as a remote error, a mode that resolves no names included. */
    resolveRootManifest,
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
      { genesisHash, connectionId }: MethodTypes<typeof methods.chain.connect>['start'],
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
      const connections: ReadonlyMap<string, unknown> = state.scopes.get(scopeId)?.connections ?? new Map();
      if (connections.has(connectionId)) {
        throw new Error(`Duplicate chain connection: ${connectionId}`);
      }
      if (connections.size >= MAX_CONNECTIONS) {
        throw new Error(`Connection limit reached (max ${String(MAX_CONNECTIONS)})`);
      }
      if (!isChainSupported(genesisHash)) {
        throw new Error(`Unsupported chain: ${genesisHash}`);
      }
      const token = Symbol(connectionId);
      const connection = pool.connectRemote({
        genesisHash,
        connectionId: `${scopeId} ${connectionId}`,
        onMessage: message => {
          sink.send({ tag: 'message', value: message });
          machine.update({ kind: 'answered', scopeId, connectionId, token, bytes: message.length });
        },
        onHalt: () => {
          machine.update({ kind: 'halted', scopeId, connectionId, token });
        },
      });
      if (connection === null) {
        throw new Error(PROTOCOL_APP_ERRORS.CHAIN_BROKER_FAILED);
      }
      machine.update({ kind: 'connected', scopeId, connectionId, token, connection, sink });
      sink.send({ tag: 'connected', value: undefined });
      return () => {
        machine.update({ kind: 'disconnected', scopeId, connectionId, token });
      };
    }

    // Typed as the protocol's handler answers, so the scope's type is no narrower than the method it serves.
    function send(
      { connectionId, message }: MethodTypes<typeof methods.chain.send>['request'],
      _context: ProtocolContext,
    ): ReturnType<ProtocolHandler<typeof methods.chain.send>> {
      assertNonEmpty(connectionId, 'connectionId');
      assertNonEmpty(message, 'message');
      const state = machine.state.get();
      const held = state.kind === 'open' ? state.scopes.get(scopeId)?.connections.get(connectionId) : undefined;
      if (held === undefined) {
        throw new Error(`Unknown chain connection: ${connectionId}`);
      }
      held.connection.send(message);
      return ok();
    }
  }

  function requireResolver(unsupported: string): EngineResolver {
    if (resolver === undefined) {
      throw new Error(unsupported);
    }
    return resolver;
  }

  /**
   * The resolver's sync budget for a read: the method's budget, counted from when the call arrives, less a grace for
   * the typed error to cross back while the call still waits.
   */
  function toSyncOptions(method: AnyMethod): { syncTimeoutMs?: number } {
    const budgetMs = getBudget(method);
    if (budgetMs === null) {
      return {};
    }
    const budget = Math.max(1, budgetMs - TIMEOUTS.RESPONSE_DELIVERY_GRACE);
    return { syncTimeoutMs: syncBudgetCapMs === undefined ? budget : Math.min(budget, syncBudgetCapMs) };
  }

  function resolveDotName(
    { label }: MethodTypes<typeof methods.resolve.dotName>['start'],
    _context: ProtocolContext,
    sink: NameSink,
  ): () => void {
    const reader = requireResolver(PROTOCOL_APP_ERRORS.RESOLVE_DOT_NAME_UNSUPPORTED);
    assertNonEmpty(label, 'label');
    void reader
      .resolveDotName(label, {
        onPhase: phase => {
          sink.send({ tag: 'phase', value: phase });
        },
        ...toSyncOptions(methods.resolve.dotName),
      })
      .then(
        resolved => {
          sink.send({ tag: 'resolved', value: resolved });
          sink.interrupt(ok());
        },
        (error: unknown) => {
          sink.interrupt(err(toRemoteEnd(toError(error))));
        },
      );
    // A read cannot be called off, and the transport drops what it sends once the host has stopped listening.
    return () => undefined;
  }

  // Each request handler below takes the context and returns what the protocol's handler returns, so the engine's
  // type is no narrower than the method it serves.
  function warmup(
    _request: MethodTypes<typeof methods.frame.warmup>['request'],
    _context: ProtocolContext,
  ): ReturnType<ProtocolHandler<typeof methods.frame.warmup>> {
    return answerWarmup(onWarmup);
  }

  function resolveOwner(
    { label }: MethodTypes<typeof methods.resolve.owner>['request'],
    _context: ProtocolContext,
  ): ReturnType<ProtocolHandler<typeof methods.resolve.owner>> {
    return answerRead(() => {
      const reader = requireResolver(PROTOCOL_APP_ERRORS.RESOLVE_OWNER_UNSUPPORTED);
      assertNonEmpty(label, 'label');
      return reader.resolveOwner(label, toSyncOptions(methods.resolve.owner));
    });
  }

  function resolveExecutableManifest(
    { label, kind }: MethodTypes<typeof methods.resolve.executableManifest>['request'],
    _context: ProtocolContext,
  ): ReturnType<ProtocolHandler<typeof methods.resolve.executableManifest>> {
    return answerRead(() => {
      const reader = requireResolver(PROTOCOL_APP_ERRORS.RESOLVE_EXECUTABLE_MANIFEST_UNSUPPORTED);
      assertNonEmpty(label, 'label');
      return reader.resolveExecutableManifest(label, kind, toSyncOptions(methods.resolve.executableManifest));
    });
  }

  function resolveRootManifest(
    { label }: MethodTypes<typeof methods.resolve.rootManifest>['request'],
    _context: ProtocolContext,
  ): ReturnType<ProtocolHandler<typeof methods.resolve.rootManifest>> {
    return answerRead(() => {
      const reader = requireResolver(PROTOCOL_APP_ERRORS.RESOLVE_ROOT_MANIFEST_UNSUPPORTED);
      assertNonEmpty(label, 'label');
      return reader.resolveRootManifest(label, toSyncOptions(methods.resolve.rootManifest));
    });
  }
}

/** Answers once `onWarmup` settles. Rejects with what it rejects with. */
async function answerWarmup(
  onWarmup: (() => Promise<void>) | undefined,
): Promise<MethodTypes<typeof methods.frame.warmup>['response']> {
  await onWarmup?.();
  return ok();
}

function assertNonEmpty(value: string, name: string): void {
  if (value.length === 0) {
    throw new Error(`Invalid ${name}: expected non-empty string`);
  }
}

/** Answers a read with its value, or with its failure as a remote error ends a call. */
async function answerRead<T>(read: () => Promise<T>): Promise<ResultPayload<T, CallError<RemoteFailure>>> {
  try {
    return ok(await read());
  } catch (error) {
    return err(toRemoteEnd(toError(error)));
  }
}

/** The live connections across every scope. */
function countConnections(state: EngineState): number {
  switch (state.kind) {
    case 'open': {
      let total = 0;
      for (const { connections } of state.scopes.values()) {
        total += connections.size;
      }
      return total;
    }
    case 'disposed':
      return 0;
  }
}
