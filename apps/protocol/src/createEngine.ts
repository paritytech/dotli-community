// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The chain and name methods, for every mode. A scope holds one tab's chain connections and budget, while the chains
// themselves are shared by every scope of the engine.

import type { ChainPool, StringJsonRpcConnection } from '@dotli/chains';
import { TIMEOUTS } from '@dotli/config';
import {
  getBudget,
  type ProtocolContext,
  type ProtocolHandler,
  protocolSchema,
  type RemoteFailure,
  toRemoteEnd,
} from '@dotli/protocol';
import type { DotnsResolver } from '@dotli/resolver';
import { toError } from '@dotli/shared';
import { err, ok, type AnyMethod, type CallError, type MethodTypes, type ResultPayload } from '@dotli/transport';

import { PROTOCOL_APP_ERRORS } from './errors.js';

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

type Connection = {
  readonly connectionId: string;
  readonly connection: StringJsonRpcConnection;
  readonly sink: ChainSink;
};

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
  const scopes = new Set<Map<string, Connection>>();
  let scopeCount = 0;

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
     * Disconnects every scope's connections and releases the pool's chains. Throws what a connection's disconnect
     * throws, never what closing a chain throws, which is reported.
     */
    dispose,
  };

  function countConnections(): number {
    let total = 0;
    for (const connections of scopes) {
      total += connections.size;
    }
    return total;
  }

  function openScope() {
    // Connection ids are unique only within a scope, so each scope keeps its own.
    const connections = new Map<string, Connection>();
    // The pool's session ids are engine-wide, so each scope prefixes its own.
    const scopeId = String(scopeCount++);

    return {
      /**
       * Opens a chain connection for the subscription. Stopping it disconnects it, and a chain halt ends it cleanly.
       * Throws on an empty or reused id, past `MAX_CONNECTIONS`, on an unsupported chain, or when the pool cannot
       * connect.
       */
      connect,
      /** Sends `message` on the connection. Throws on an empty field or an unknown connection. */
      send,
      /**
       * Ends each connection's subscription cleanly and releases it. The scope stays usable. Throws what a
       * connection's disconnect throws.
       */
      close,
    };

    /** Forgets the connection if it is still the one held under its id. */
    function forget(held: Connection): boolean {
      if (connections.get(held.connectionId) !== held) {
        return false;
      }
      connections.delete(held.connectionId);
      return true;
    }

    function connect(
      { genesisHash, connectionId }: MethodTypes<typeof methods.chain.connect>['start'],
      _context: ProtocolContext,
      sink: ChainSink,
    ): () => void {
      assertNonEmpty(genesisHash, 'genesisHash');
      assertNonEmpty(connectionId, 'connectionId');
      if (connections.has(connectionId)) {
        throw new Error(`Duplicate chain connection: ${connectionId}`);
      }
      if (connections.size >= MAX_CONNECTIONS) {
        throw new Error(`Connection limit reached (max ${String(MAX_CONNECTIONS)})`);
      }
      if (!isChainSupported(genesisHash)) {
        throw new Error(`Unsupported chain: ${genesisHash}`);
      }
      // Only the first message is noted, later ones would push the load's steps out of the breadcrumb trail.
      let answered = false;
      let held: Connection | null = null;
      const connection = pool.connectRemote({
        genesisHash,
        connectionId: `${scopeId} ${connectionId}`,
        onMessage: message => {
          if (!answered) {
            answered = true;
            log(`First chain message for ${connectionId} (${String(message.length)} bytes)`);
          }
          sink.send({ tag: 'message', value: message });
        },
        onHalt: () => {
          // The broker has already answered pending requests and stopped follows, so there is nothing to disconnect.
          if (held === null || !forget(held)) {
            return;
          }
          log(`Chain halted: ${connectionId} (${String(countConnections())} remaining)`);
          sink.interrupt(ok());
        },
      });
      if (connection === null) {
        throw new Error(PROTOCOL_APP_ERRORS.CHAIN_BROKER_FAILED);
      }
      const opened: Connection = { connectionId, connection, sink };
      held = opened;
      connections.set(connectionId, opened);
      scopes.add(connections);
      log(`Chain connected: ${connectionId} (${String(countConnections())} total)`);
      sink.send({ tag: 'connected', value: undefined });
      return disconnect;

      function disconnect(): void {
        if (forget(opened)) {
          opened.connection.disconnect();
          log(`Chain disconnected: ${connectionId} (${String(countConnections())} remaining)`);
        }
      }
    }

    // Typed as the protocol's handler answers, so the scope's type is no narrower than the method it serves.
    function send(
      { connectionId, message }: MethodTypes<typeof methods.chain.send>['request'],
      _context: ProtocolContext,
    ): ReturnType<ProtocolHandler<typeof methods.chain.send>> {
      assertNonEmpty(connectionId, 'connectionId');
      assertNonEmpty(message, 'message');
      const held = connections.get(connectionId);
      if (held === undefined) {
        throw new Error(`Unknown chain connection: ${connectionId}`);
      }
      held.connection.send(message);
      return ok();
    }

    function close(): void {
      for (const held of [...connections.values()]) {
        // Forgotten first, so neither the end nor a halt the disconnect causes releases it again.
        forget(held);
        held.sink.interrupt(ok());
        held.connection.disconnect();
      }
      scopes.delete(connections);
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

  function dispose(): void {
    for (const connections of [...scopes]) {
      for (const held of connections.values()) {
        held.connection.disconnect();
      }
      connections.clear();
    }
    scopes.clear();
    pool.disconnectAll();
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
