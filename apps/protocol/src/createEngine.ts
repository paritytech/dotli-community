// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The chain and name methods, for every mode. A scope holds one tab's chain connections and budget, while the chains
// themselves are shared by every scope of the engine.

import type { ChainPool, StringJsonRpcConnection } from '@dotli/chains';
import { createReporter, defineCount } from '@dotli/metrics';
import type { ProtocolContext, ProtocolHandler, protocolSchema } from '@dotli/protocol';
import { ok, type MethodTypes } from '@dotli/transport';

import { assertNonEmpty } from './assertNonEmpty.js';
import { createNameReads, type NameReadsParams } from './createNameReads.js';
import { PROTOCOL_APP_ERRORS } from './errors.js';

const report = createReporter({ flow: 'protocol' });
/** A chain connection's disconnect threw as its scope closed or the engine was disposed. */
const engineDisconnectMetric = defineCount<'error'>('protocol.engine.disconnect');

type ChainSink = Parameters<ProtocolHandler<Methods['chain']['connect']>>[2];

/** One tab's chain connections and budget. */
export type EngineScope = ReturnType<ProtocolEngine['openScope']>;

/** The chain and name methods, with the chains every scope shares. */
export type ProtocolEngine = ReturnType<typeof createEngine>;

export type EngineParams = NameReadsParams & {
  /** The chains every scope connects to. `dispose` releases them. */
  pool: ChainPool;
  /** Whether a scope may connect to the chain. */
  isChainSupported: (genesisHash: string) => boolean;
  /** Runs on each warmup call, which answers once it settles and rejects with what it rejects with. */
  onWarmup?: () => Promise<void>;
  /** Breadcrumbs for each connection's first answer, halt and close. */
  log?: (message: string) => void;
};

/** A live connection, and whether it has heard its first message, which is the only one noted. */
type Held = { connection: StringJsonRpcConnection; sink: ChainSink; answered: boolean };

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
  // Each tab's live connections by scope id, then by connection id. A scope with none leaves the map.
  const scopes = new Map<string, Map<string, Held>>();
  let disposed = false;
  // The pool's session ids are engine-wide, so each scope prefixes its own.
  let scopeCount = 0;

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
    if (disposed) {
      return;
    }
    disposed = true;
    const held = [...scopes.values()].flatMap(connections => [...connections.values()]);
    scopes.clear();
    for (const { connection } of held) {
      disconnect(connection);
    }
    pool.disconnectAll();
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
      const connections = scopes.get(scopeId);
      if (connections === undefined) {
        return;
      }
      // Forgotten first, so neither the end nor a halt the disconnect causes releases a connection again.
      scopes.delete(scopeId);
      for (const { connection, sink } of connections.values()) {
        disconnect(connection);
        sink.interrupt(ok());
      }
    }

    /** Forgets the connection under `connectionId` if it is still `held`. Returns whether it was. */
    function forget(connectionId: string, held: Held): boolean {
      const connections = scopes.get(scopeId);
      if (connections?.get(connectionId) !== held) {
        return false;
      }
      connections.delete(connectionId);
      if (connections.size === 0) {
        scopes.delete(scopeId);
      }
      return true;
    }

    function connect(
      { genesisHash, connectionId }: MethodTypes<Methods['chain']['connect']>['start'],
      _context: ProtocolContext,
      sink: ChainSink,
    ): () => void {
      if (disposed) {
        throw new Error('The engine was disposed');
      }
      assertNonEmpty(genesisHash, 'genesisHash');
      assertNonEmpty(connectionId, 'connectionId');
      // Connection ids are unique only within a scope, so each scope checks its own.
      const connections = scopes.get(scopeId) ?? new Map<string, Held>();
      if (connections.has(connectionId)) {
        throw new Error(`Duplicate chain connection: ${connectionId}`);
      }
      if (connections.size >= MAX_CONNECTIONS) {
        throw new Error(`Connection limit reached (max ${String(MAX_CONNECTIONS)})`);
      }
      if (!isChainSupported(genesisHash)) {
        throw new Error(`Unsupported chain: ${genesisHash}`);
      }
      // Set once the pool hands the connection over, so a message or halt before then finds nothing.
      let held: Held | null = null;
      const connection = pool.connectRemote({
        genesisHash,
        connectionId: `${scopeId} ${connectionId}`,
        onMessage: message => {
          if (held === null || scopes.get(scopeId)?.get(connectionId) !== held) {
            return;
          }
          if (!held.answered) {
            held.answered = true;
            log(`First chain message for ${connectionId} (${String(message.length)} bytes)`);
          }
          sink.send({ tag: 'message', value: message });
        },
        onHalt: () => {
          // The broker has already answered pending requests and stopped follows, so there is nothing to disconnect.
          if (held === null || !forget(connectionId, held)) {
            return;
          }
          log(`Chain halted: ${connectionId} (${String(countConnections())} remaining)`);
          sink.interrupt(ok());
        },
      });
      if (connection === null) {
        throw new Error(PROTOCOL_APP_ERRORS.CHAIN_BROKER_FAILED);
      }
      const opened: Held = { connection, sink, answered: false };
      held = opened;
      connections.set(connectionId, opened);
      scopes.set(scopeId, connections);
      log(`Chain connected: ${connectionId} (${String(countConnections())} total)`);
      sink.send({ tag: 'connected', value: undefined });
      return () => {
        if (forget(connectionId, opened)) {
          disconnect(connection);
          log(`Chain disconnected: ${connectionId} (${String(countConnections())} remaining)`);
        }
      };
    }

    // Typed as the protocol's handler answers, so the scope's type is no narrower than the method it serves.
    function send(
      { connectionId, message }: MethodTypes<Methods['chain']['send']>['request'],
      _context: ProtocolContext,
    ): ReturnType<ProtocolHandler<Methods['chain']['send']>> {
      assertNonEmpty(connectionId, 'connectionId');
      assertNonEmpty(message, 'message');
      const held = scopes.get(scopeId)?.get(connectionId);
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

  /** The live connections across every scope. */
  function countConnections(): number {
    let total = 0;
    for (const connections of scopes.values()) {
      total += connections.size;
    }
    return total;
  }

  /** Disconnects `connection`, reporting a throw so the other connections and the caller carry on. */
  function disconnect(connection: StringJsonRpcConnection): void {
    try {
      connection.disconnect();
    } catch (error) {
      report.defect(error, {
        step: 'disconnect',
        metric: engineDisconnectMetric,
        message: '[dot.li] A chain connection could not be disconnected:',
      });
    }
  }
}
