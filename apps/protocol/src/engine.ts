// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The chain and name methods, for every mode. A scope holds one tab's chain connections and budget, while the chains
// themselves are shared by every scope of the engine.

import type { ChainPool, StringJsonRpcConnection } from '@dotli/chains';
import { TIMEOUTS } from '@dotli/config';
import { reportListener } from '@dotli/metrics';
import { budgetOf, RESOLVE_BUDGET_MS, type ProtocolSchema, type ProtocolTransport } from '@dotli/protocol';
import type { DotnsResolver } from '@dotli/resolver';
import { errorMessage, errorName, toError } from '@dotli/shared';
import {
  domain,
  err,
  hostFailure,
  ok,
  type CallError,
  type DomainError,
  type RequestHandler,
  type Result,
  type SubscriptionHandler,
} from '@dotli/transport';

import { PROTOCOL_APP_ERRORS } from './errors.js';

type S = ProtocolSchema;

/** The resolver and chain failures the host's error screen tells apart. */
type RemoteFailure = DomainError<S, 'resolve', 'owner'>;

type ChainSink = Parameters<SubscriptionHandler<S, 'chain', 'connect'>>[2];

export interface EngineScope {
  /** Opens a chain connection for the subscription. Stopping it disconnects it, and a chain halt ends it cleanly. */
  connect: SubscriptionHandler<S, 'chain', 'connect'>;
  send: RequestHandler<S, 'chain', 'send'>;
  /**
   * Ends each connection's subscription cleanly, releases it and returns how many there were. The scope stays
   * usable.
   */
  close: () => number;
}

export interface ProtocolEngine {
  /** A new tab's scope. The iframe modes serve one tab, the SharedWorker one per port. */
  openScope: () => EngineScope;
  warmup: RequestHandler<S, 'frame', 'warmup'>;
  /** Sends each phase, then the result, then ends cleanly. */
  resolveDotName: SubscriptionHandler<S, 'resolve', 'dotName'>;
  resolveOwner: RequestHandler<S, 'resolve', 'owner'>;
  resolveExecutableManifest: RequestHandler<S, 'resolve', 'executableManifest'>;
  resolveRootManifest: RequestHandler<S, 'resolve', 'rootManifest'>;
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
  /** Hears a sink that throws as a name read settles, which no caller is left to catch. Captured by default. */
  report?: (error: unknown) => void;
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
  readonly sink: ChainSink;
}

function assertStr(value: string, name: string): void {
  if (value.length === 0) {
    throw new Error(`Invalid ${name}: expected non-empty string`);
  }
}

/** A failure the host's error screen tells apart by name, typed, or null for any other, which crosses as thrown. */
function remoteFailureOf(error: unknown): RemoteFailure | null {
  const name = errorName(error);
  if (name === 'NetworkSyncTimeoutError') {
    return { tag: 'syncTimeout', value: errorMessage(error) };
  }
  if (name === 'ApiStoppedError') {
    return { tag: 'apiStopped', value: errorMessage(error) };
  }
  return null;
}

/** Answers a read with its value or its typed failure. Any other failure is thrown, so it crosses as the handler's. */
async function answerRead<T>(read: () => Promise<T>): Promise<Result<T, CallError<RemoteFailure>>> {
  try {
    return ok(await read());
  } catch (error) {
    const failure = remoteFailureOf(error);
    if (failure === null) {
      throw error;
    }
    return err(domain(failure));
  }
}

/** How a read that failed with `error` ends its subscription. */
function readEnd(error: unknown): CallError<RemoteFailure> {
  const failure = remoteFailureOf(error);
  return failure === null ? hostFailure(toError(error)) : domain(failure);
}

/** Serves a new scope of `engine` on `serving`: that scope's chain connections, and the engine's name reads. */
export function serveEngineScope(serving: ProtocolTransport, engine: ProtocolEngine): EngineScope {
  const scope = engine.openScope();
  serving.handleRequest('frame', 'warmup', engine.warmup);
  serving.handleSubscription('resolve', 'dotName', engine.resolveDotName);
  serving.handleRequest('resolve', 'owner', engine.resolveOwner);
  serving.handleRequest('resolve', 'executableManifest', engine.resolveExecutableManifest);
  serving.handleRequest('resolve', 'rootManifest', engine.resolveRootManifest);
  serving.handleSubscription('chain', 'connect', scope.connect);
  serving.handleRequest('chain', 'send', scope.send);
  return scope;
}

export function createEngine(options: EngineOptions): ProtocolEngine {
  const { pool } = options;
  const note = options.log ?? ((): void => undefined);
  const report = options.report ?? reportListener('protocol', 'protocol.engine');

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
          sink.receive({ tag: 'message', value: message });
        },
        () => {
          // The broker has already answered pending requests and stopped follows, so there is nothing to disconnect.
          if (held === null || !forget(held)) {
            return;
          }
          note(`Chain halted: ${connectionId} (${String(totalConnections())} remaining)`);
          sink.interrupt();
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
      sink.receive({ tag: 'connected', value: undefined });
      return () => {
        if (forget(opened)) {
          opened.connection.disconnect();
          note(`Chain disconnected: ${connectionId} (${String(totalConnections())} remaining)`);
        }
      };
    };

    const send: EngineScope['send'] = ({ connectionId, message }) => {
      assertStr(connectionId, 'connectionId');
      assertStr(message, 'message');
      const held = connections.get(connectionId);
      if (held === undefined) {
        throw new Error(`Unknown chain connection: ${connectionId}`);
      }
      held.connection.send(message);
      return ok();
    };

    function close(): number {
      let released = 0;
      for (const held of [...connections.values()]) {
        // Forgotten first, so neither the end nor a halt the disconnect causes releases it again.
        forget(held);
        held.sink.interrupt();
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

  /**
   * The resolver's sync budget for a read the host gives up on after `budgetMs`, counted from when the call arrives,
   * less a grace for the typed error to cross back before the host gives up.
   */
  function syncOptions(budgetMs: number | null): { syncTimeoutMs?: number } {
    if (budgetMs === null) {
      return {};
    }
    const budget = Math.max(1, budgetMs - TIMEOUTS.RESPONSE_DELIVERY_GRACE);
    const cap = options.syncBudgetCapMs;
    return { syncTimeoutMs: cap === undefined ? budget : Math.min(budget, cap) };
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
      return ok();
    },
    resolveDotName: ({ label }, _context, sink) => {
      const resolver = requireResolver(PROTOCOL_APP_ERRORS.RESOLVE_DOT_NAME_UNSUPPORTED);
      assertStr(label, 'label');
      const end = (error?: CallError<RemoteFailure>): void => {
        try {
          sink.interrupt(error);
        } catch (endError) {
          report(endError);
        }
      };
      void resolver
        .resolveDotName(label, {
          onPhase: phase => {
            sink.receive({ tag: 'phase', value: phase });
          },
          ...syncOptions(RESOLVE_BUDGET_MS),
        })
        .then(
          resolved => {
            try {
              sink.receive({ tag: 'resolved', value: resolved });
            } catch (error) {
              report(error);
              // The host hears a failure instead of waiting on a read that is over.
              end(readEnd(error));
              return;
            }
            end();
          },
          (error: unknown) => {
            end(readEnd(error));
          },
        );
      // A read cannot be called off, and the transport drops what it sends once the host has stopped listening.
      return () => undefined;
    },
    resolveOwner: ({ label }) =>
      answerRead(() => {
        const resolver = requireResolver(PROTOCOL_APP_ERRORS.RESOLVE_OWNER_UNSUPPORTED);
        assertStr(label, 'label');
        return resolver.resolveOwner(label, syncOptions(budgetOf('resolve', 'owner')));
      }),
    resolveExecutableManifest: ({ label, kind }) =>
      answerRead(() => {
        const resolver = requireResolver(PROTOCOL_APP_ERRORS.RESOLVE_EXECUTABLE_MANIFEST_UNSUPPORTED);
        assertStr(label, 'label');
        return resolver.resolveExecutableManifest(label, kind, syncOptions(budgetOf('resolve', 'executableManifest')));
      }),
    resolveRootManifest: ({ label }) =>
      answerRead(() => {
        const resolver = requireResolver(PROTOCOL_APP_ERRORS.RESOLVE_ROOT_MANIFEST_UNSUPPORTED);
        assertStr(label, 'label');
        return resolver.resolveRootManifest(label, syncOptions(budgetOf('resolve', 'rootManifest')));
      }),
    cleanup,
  };
}
