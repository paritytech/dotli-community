// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The chain and name methods, for every mode. A scope holds one tab's chain connections and budget, while the chains
// themselves are shared by every scope of the engine.

import type { ChainPool, StringJsonRpcConnection } from '@dotli/chains';
import { TIMEOUTS } from '@dotli/config';
import type { DotnsResolver } from '@dotli/resolver';
import type {
  CallContext,
  RequestHandler,
  ServingTransport,
  SubscriptionHandler,
  SubscriptionSink,
} from '@dotli/protocol';
import { realTimers, toError, type Timers } from '@dotli/shared';

import { PROTOCOL_APP_ERRORS } from './errors.js';

export interface EngineScope {
  /** Opens a chain connection for the subscription. Unsubscribing disconnects it, and a chain halt ends it cleanly. */
  connect: SubscriptionHandler<'chainConnect'>;
  send: RequestHandler<'chainSend'>;
  /**
   * Ends each connection's subscription cleanly, releases it and returns how many there were. The scope stays
   * usable.
   */
  close: () => number;
}

export interface ProtocolEngine {
  /** A new tab's scope. The iframe modes serve one tab, the SharedWorker one per port. */
  openScope: () => EngineScope;
  warmup: RequestHandler<'warmup'>;
  /** Sends each phase, then the result, then ends cleanly. */
  resolveDotName: SubscriptionHandler<'resolveDotName'>;
  resolveOwner: RequestHandler<'resolveOwner'>;
  resolveExecutableManifest: RequestHandler<'resolveExecutableManifest'>;
  resolveRootManifest: RequestHandler<'resolveRootManifest'>;
  cleanup: () => void;
}

export interface EngineOptions {
  /**
   * The chains every scope connects to. The caller builds it, so the name resolver can read through the same
   * follows. `cleanup` releases its chains.
   */
  pool: ChainPool;
  isChainSupported: (genesisHash: string) => boolean;
  onWarmup?: () => Promise<void>;
  /** Breadcrumbs for each connection's first answer, halt and close, which the SharedWorker keeps. */
  log?: (message: string) => void;
  /**
   * The name reads. Unset in `rpc-gateway` mode, which resolves in the host process, so each read is refused at once
   * instead of leaving the caller to hang.
   */
  resolver?: EngineResolver;
  /** Caps each read's sync budget, for a tester who needs a timeout to show quickly. */
  syncBudgetCapMs?: number | undefined;
  /** The clock a call's deadline is read against. Defaults to `realTimers`. */
  timers?: Pick<Timers, 'now'>;
}

export type EngineResolver = Pick<
  DotnsResolver,
  'resolveDotName' | 'resolveOwner' | 'resolveExecutableManifest' | 'resolveRootManifest'
>;

/** One scope's budget, which is one tab's. */
export const MAX_CONNS = 10;

interface Connection {
  readonly genesisHash: string;
  readonly connectionId: string;
  readonly connection: StringJsonRpcConnection;
  readonly sink: SubscriptionSink<'chainConnect'>;
}

function assertStr(value: string, name: string): void {
  if (value.length === 0) {
    throw new Error(`Invalid ${name}: expected non-empty string`);
  }
}

/**
 * What is left of the caller's deadline for the resolver to sync, less a grace for the typed error to cross back to
 * the host before the host gives up.
 */
function syncBudgetMs(deadlineMs: number | null, now: number): number | undefined {
  if (deadlineMs === null) {
    return undefined;
  }
  return Math.max(1, Math.floor(deadlineMs - now - TIMEOUTS.RESPONSE_DELIVERY_GRACE));
}

/** Serves a new scope of `engine` on `serving`: that scope's chain connections, and the engine's name reads. */
export function serveEngineScope(serving: ServingTransport, engine: ProtocolEngine): EngineScope {
  const scope = engine.openScope();
  serving.handleRequest('warmup', engine.warmup);
  serving.handleSubscription('resolveDotName', engine.resolveDotName);
  serving.handleRequest('resolveOwner', engine.resolveOwner);
  serving.handleRequest('resolveExecutableManifest', engine.resolveExecutableManifest);
  serving.handleRequest('resolveRootManifest', engine.resolveRootManifest);
  serving.handleSubscription('chainConnect', scope.connect);
  serving.handleRequest('chainSend', scope.send);
  return scope;
}

export function createEngine(options: EngineOptions): ProtocolEngine {
  const { pool } = options;
  const note = options.log ?? ((): void => undefined);
  const timers = options.timers ?? realTimers;

  const scopes = new Set<Map<string, Connection>>();
  let scopeCount = 0;

  function totalConnections(): number {
    let total = 0;
    for (const connections of scopes) {
      total += connections.size;
    }
    return total;
  }

  function openScope(): EngineScope {
    // Connection ids are the host's own, and a scope serves one host page.
    const connections = new Map<string, Connection>();
    // The pool's session ids are engine-wide, so each scope prefixes its own.
    const scopeId = String(scopeCount++);

    /** Forgets the connection if it is still the one held under its id. */
    function forget(held: Connection): boolean {
      if (connections.get(held.connectionId) !== held) {
        return false;
      }
      connections.delete(held.connectionId);
      return true;
    }

    const connect: EngineScope['connect'] = ({ genesisHash, connectionId }, _context, sink) => {
      assertStr(genesisHash, 'genesisHash');
      assertStr(connectionId, 'connectionId');
      if (connections.has(connectionId)) {
        throw new Error(`Duplicate chain connection: ${connectionId}`);
      }
      if (connections.size >= MAX_CONNS) {
        throw new Error(`Connection limit reached (max ${String(MAX_CONNS)})`);
      }
      if (!options.isChainSupported(genesisHash)) {
        throw new Error(`Unsupported chain: ${genesisHash}`);
      }
      // Only the first message is noted, later ones would push the load's steps out of the breadcrumb trail.
      let answered = false;
      let held: Connection | null = null;
      const connection = pool.connectRemote(
        genesisHash,
        `${scopeId} ${connectionId}`,
        message => {
          if (!answered) {
            answered = true;
            note(`First chain message for ${connectionId} (${String(message.length)} bytes)`);
          }
          sink.send({ tag: 'message', value: message });
        },
        () => {
          // The broker has already answered pending requests and stopped follows, so there is nothing to disconnect.
          if (held === null || !forget(held)) {
            return;
          }
          note(`Chain halted: ${connectionId} (${String(totalConnections())} remaining)`);
          sink.end();
        },
      );
      if (connection === null) {
        throw new Error(PROTOCOL_APP_ERRORS.CHAIN_BROKER_FAILED);
      }
      const opened: Connection = { genesisHash, connectionId, connection, sink };
      held = opened;
      connections.set(connectionId, opened);
      scopes.add(connections);
      note(`Chain connected: ${connectionId} (${String(totalConnections())} total)`);
      sink.send({ tag: 'connected', value: undefined });
      return () => {
        if (forget(opened)) {
          opened.connection.disconnect();
          note(`Chain disconnected: ${connectionId} (${String(totalConnections())} remaining)`);
        }
      };
    };

    const send: EngineScope['send'] = ({ connectionId, message }) => {
      assertStr(message, 'message');
      const held = connections.get(connectionId);
      if (held === undefined) {
        throw new Error(`Unknown chain connection: ${connectionId}`);
      }
      held.connection.send(message);
    };

    function close(): number {
      let released = 0;
      for (const held of [...connections.values()]) {
        // Forgotten first, so neither the end nor a halt the disconnect causes releases it again.
        forget(held);
        held.sink.end();
        held.connection.disconnect();
        released += 1;
      }
      scopes.delete(connections);
      return released;
    }

    return { connect, send, close };
  }

  function requireResolver(unsupported: string): EngineResolver {
    if (options.resolver === undefined) {
      throw new Error(unsupported);
    }
    return options.resolver;
  }

  function syncOptions(context: CallContext): { syncTimeoutMs?: number } {
    const budget = syncBudgetMs(context.deadlineMs, timers.now());
    const cap = options.syncBudgetCapMs;
    const syncTimeoutMs = cap === undefined || budget === undefined ? budget : Math.min(budget, cap);
    return syncTimeoutMs !== undefined ? { syncTimeoutMs } : {};
  }

  function cleanup(): void {
    for (const connections of [...scopes]) {
      for (const held of connections.values()) {
        held.connection.disconnect();
      }
      connections.clear();
    }
    scopes.clear();
    pool.disconnectAll();
  }

  return {
    openScope,
    warmup: async () => {
      await options.onWarmup?.();
    },
    resolveDotName: ({ label }, context, sink) => {
      const resolver = requireResolver(PROTOCOL_APP_ERRORS.RESOLVE_DOT_NAME_UNSUPPORTED);
      assertStr(label, 'label');
      void resolver
        .resolveDotName(label, {
          onPhase: phase => {
            sink.send({ tag: 'phase', value: phase });
          },
          ...syncOptions(context),
        })
        .then(
          resolved => {
            sink.send({ tag: 'resolved', value: resolved });
            sink.end();
          },
          (error: unknown) => {
            sink.end(toError(error));
          },
        );
      // A read cannot be called off, and the transport drops what it sends once the host has stopped listening.
      return () => undefined;
    },
    resolveOwner: ({ label }, context) => {
      const resolver = requireResolver(PROTOCOL_APP_ERRORS.RESOLVE_OWNER_UNSUPPORTED);
      assertStr(label, 'label');
      return resolver.resolveOwner(label, syncOptions(context));
    },
    resolveExecutableManifest: ({ label, kind }, context) => {
      const resolver = requireResolver(PROTOCOL_APP_ERRORS.RESOLVE_EXECUTABLE_MANIFEST_UNSUPPORTED);
      assertStr(label, 'label');
      return resolver.resolveExecutableManifest(label, kind, syncOptions(context));
    },
    resolveRootManifest: ({ label }, context) => {
      const resolver = requireResolver(PROTOCOL_APP_ERRORS.RESOLVE_ROOT_MANIFEST_UNSUPPORTED);
      assertStr(label, 'label');
      return resolver.resolveRootManifest(label, syncOptions(context));
    },
    cleanup,
  };
}
