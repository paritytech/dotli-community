// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The chain and name methods, for every mode. A scope holds one tab's chain connections and budget, while the chains
// themselves are shared by every scope of the engine.

import type { ChainPool, StringJsonRpcConnection } from '@dotli/chains';
import { TIMEOUTS } from '@dotli/config';
import {
  budgetOf,
  type ProtocolHandler,
  protocolSchema,
  type ProtocolServing,
  type RemoteFailure,
  remoteEnd,
} from '@dotli/protocol';
import type { DotnsResolver } from '@dotli/resolver';
import { toError } from '@dotli/shared';
import { err, ok, type AnyMethod, type CallError, type ResultPayload } from '@dotli/transport';

import { PROTOCOL_APP_ERRORS } from './errors.js';

const methods = protocolSchema.sections;

type ChainSink = Parameters<ProtocolHandler<typeof methods.chain.connect>>[2];

export interface EngineScope {
  /** Opens a chain connection for the subscription. Stopping it disconnects it, and a chain halt ends it cleanly. */
  connect: ProtocolHandler<typeof methods.chain.connect>;
  send: ProtocolHandler<typeof methods.chain.send>;
  /** Ends each connection's subscription cleanly and releases it. The scope stays usable. */
  close: () => void;
}

export interface ProtocolEngine {
  /** A new tab's scope. The iframe modes serve one tab, the SharedWorker one per port. */
  openScope: () => EngineScope;
  warmup: ProtocolHandler<typeof methods.frame.warmup>;
  /** Sends each phase, then the result, then ends cleanly. */
  resolveDotName: ProtocolHandler<typeof methods.resolve.dotName>;
  resolveOwner: ProtocolHandler<typeof methods.resolve.owner>;
  resolveExecutableManifest: ProtocolHandler<typeof methods.resolve.executableManifest>;
  resolveRootManifest: ProtocolHandler<typeof methods.resolve.rootManifest>;
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
}

export type EngineResolver = Pick<
  DotnsResolver,
  'resolveDotName' | 'resolveOwner' | 'resolveExecutableManifest' | 'resolveRootManifest'
>;

/** One scope's budget, which is one tab's. */
export const MAX_CONNS = 10;

interface Connection {
  readonly connectionId: string;
  readonly connection: StringJsonRpcConnection;
  readonly sink: ChainSink;
}

function assertStr(value: string, name: string): void {
  if (value.length === 0) {
    throw new Error(`Invalid ${name}: expected non-empty string`);
  }
}

/** Answers a read with its value, or with its failure as a remote error ends a call. */
async function answerRead<T>(read: () => Promise<T>): Promise<ResultPayload<T, CallError<RemoteFailure>>> {
  try {
    return ok(await read());
  } catch (error) {
    return err(remoteEnd(toError(error)));
  }
}

/** What serves the chain and name methods: the engine and its scope, a relay to the worker, or the worker's traces. */
export type EngineMethods = Omit<ProtocolEngine, 'openScope' | 'cleanup'> & Pick<EngineScope, 'connect' | 'send'>;

/** Serves every chain and name method on `serving`, so no side can leave one out. */
export function serveEngineMethods(serving: ProtocolServing, served: EngineMethods): void {
  serving.handleRequest(methods.frame.warmup, served.warmup);
  serving.handleSubscription(methods.resolve.dotName, served.resolveDotName);
  serving.handleRequest(methods.resolve.owner, served.resolveOwner);
  serving.handleRequest(methods.resolve.executableManifest, served.resolveExecutableManifest);
  serving.handleRequest(methods.resolve.rootManifest, served.resolveRootManifest);
  serving.handleSubscription(methods.chain.connect, served.connect);
  serving.handleRequest(methods.chain.send, served.send);
}

/** Serves a new scope of `engine` on `serving`: that scope's chain connections, and the engine's name reads. */
export function serveEngineScope(serving: ProtocolServing, engine: ProtocolEngine): EngineScope {
  const scope = engine.openScope();
  serveEngineMethods(serving, { ...engine, ...scope });
  return scope;
}

export function createEngine(options: EngineOptions): ProtocolEngine {
  const { pool } = options;
  const note = options.log ?? ((): void => undefined);

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
          sink.interrupt(ok());
        },
      );
      if (connection === null) {
        throw new Error(PROTOCOL_APP_ERRORS.CHAIN_BROKER_FAILED);
      }
      const opened: Connection = { connectionId, connection, sink };
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
      assertStr(connectionId, 'connectionId');
      assertStr(message, 'message');
      const held = connections.get(connectionId);
      if (held === undefined) {
        throw new Error(`Unknown chain connection: ${connectionId}`);
      }
      held.connection.send(message);
      return ok();
    };

    function close(): void {
      for (const held of [...connections.values()]) {
        // Forgotten first, so neither the end nor a halt the disconnect causes releases it again.
        forget(held);
        held.sink.interrupt(ok());
        held.connection.disconnect();
      }
      scopes.delete(connections);
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
   * The resolver's sync budget for a read the host gives up on after the method's budget, counted from when the call
   * arrives, less a grace for the typed error to cross back before the host gives up.
   */
  function syncOptions(method: AnyMethod): { syncTimeoutMs?: number } {
    const budgetMs = budgetOf(method);
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
      void resolver
        .resolveDotName(label, {
          onPhase: phase => {
            sink.send({ tag: 'phase', value: phase });
          },
          ...syncOptions(methods.resolve.dotName),
        })
        .then(
          resolved => {
            sink.send({ tag: 'resolved', value: resolved });
            sink.interrupt(ok());
          },
          (error: unknown) => {
            sink.interrupt(err(remoteEnd(toError(error))));
          },
        );
      // A read cannot be called off, and the transport drops what it sends once the host has stopped listening.
      return () => undefined;
    },
    resolveOwner: ({ label }) =>
      answerRead(() => {
        const resolver = requireResolver(PROTOCOL_APP_ERRORS.RESOLVE_OWNER_UNSUPPORTED);
        assertStr(label, 'label');
        return resolver.resolveOwner(label, syncOptions(methods.resolve.owner));
      }),
    resolveExecutableManifest: ({ label, kind }) =>
      answerRead(() => {
        const resolver = requireResolver(PROTOCOL_APP_ERRORS.RESOLVE_EXECUTABLE_MANIFEST_UNSUPPORTED);
        assertStr(label, 'label');
        return resolver.resolveExecutableManifest(label, kind, syncOptions(methods.resolve.executableManifest));
      }),
    resolveRootManifest: ({ label }) =>
      answerRead(() => {
        const resolver = requireResolver(PROTOCOL_APP_ERRORS.RESOLVE_ROOT_MANIFEST_UNSUPPORTED);
        assertStr(label, 'label');
        return resolver.resolveRootManifest(label, syncOptions(methods.resolve.rootManifest));
      }),
    cleanup,
  };
}
