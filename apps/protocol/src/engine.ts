// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The one protocol dispatch, for every mode. A scope holds one tab's chain connections and budget, while the chains
// themselves are shared by every scope of the engine.

import type { ChainPool, StringJsonRpcConnection } from '@dotli/chains';
import { type DotnsResolver, isExecutableKind } from '@dotli/resolver';
import {
  isSharedAuthRequestMethod,
  isSharedModeRequestMethod,
  isSharedWalletRequestMethod,
  getRequestSyncTimeoutMs,
  type ProtocolEnvelope,
  type ProtocolRequestEnvelope,
  type ProtocolRequestMap,
} from '@dotli/protocol';

import { PROTOCOL_APP_ERRORS } from './errors.js';

export type ResponseCallback = (envelope: ProtocolEnvelope) => void;

export interface EngineScope {
  handleRequest: (request: ProtocolRequestEnvelope, origin: string, respond: ResponseCallback) => Promise<void>;
  /**
   * Releases the scope's connections and returns how many there were. With `halt`, each consumer first hears its
   * connection halted, for a tab that may still be listening. The scope stays usable.
   */
  close: (options?: { halt?: boolean }) => number;
}

export interface ProtocolEngine {
  /** A new tab's scope. The iframe modes serve one tab, the SharedWorker one per port. */
  openScope: () => EngineScope;
  cleanup: () => void;
}

export interface EngineOptions {
  /**
   * The chains every scope connects to. The caller builds it, so the name resolver can read through the same
   * follows. `cleanup` releases its chains.
   */
  broker: ChainPool;
  isChainSupported: (genesisHash: string) => boolean;
  onWarmup?: () => Promise<void>;
  /** Breadcrumbs for each connection's first answer, halt and close, which the SharedWorker keeps. */
  log?: (message: string) => void;
  /**
   * The name reads. Unset in `rpc-gateway` mode, which resolves in the host process, so each read rejects at once
   * instead of leaving the caller to hang.
   */
  resolver?: EngineResolver;
  /** Caps each request's sync budget, for a tester who needs a timeout to show quickly. */
  syncBudgetCapMs?: number | undefined;
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
  readonly respond: ResponseCallback;
}

function assertStr(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Invalid ${name}: expected non-empty string`);
  }
}

// The frame's answers are not typed against ProtocolResponseMap, so the specs are what keep the two in step.
function ok(respond: ResponseCallback, id: string, result: unknown): void {
  respond({ namespace: 'dotli:protocol', kind: 'response', id, ok: true, result });
}

export function createEngine(options: EngineOptions): ProtocolEngine {
  const { broker, resolver } = options;
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
    const connections = new Map<string, Connection>();
    // The broker's session ids are engine-wide, so each scope prefixes its own.
    const scopeId = String(scopeCount++);

    /** Connection ids are the client's own, so each origin has its own namespace (origins contain no spaces). */
    function connectionKey(origin: string, connectionId: string): string {
      return `${origin} ${connectionId}`;
    }

    function forget(key: string): Connection | null {
      const connection = connections.get(key);
      connections.delete(key);
      return connection ?? null;
    }

    function connect(request: ProtocolRequestEnvelope, origin: string, respond: ResponseCallback): void {
      const payload = request.payload as ProtocolRequestMap['chainConnect'];
      assertStr(payload.genesisHash, 'genesisHash');
      assertStr(payload.connectionId, 'connectionId');
      const { connectionId, genesisHash } = payload;
      const key = connectionKey(origin, connectionId);
      const existing = connections.get(key);
      if (existing !== undefined) {
        if (existing.genesisHash !== genesisHash) {
          throw new Error(`Duplicate chain connection: ${connectionId}`);
        }
        // A repeated connect, such as a retry whose first answer was lost, keeps the connection it opened.
        ok(respond, request.id, true);
        return;
      }
      if (connections.size >= MAX_CONNS) {
        throw new Error(`Connection limit reached (max ${String(MAX_CONNS)})`);
      }
      if (!options.isChainSupported(genesisHash)) {
        throw new Error(`Unsupported chain: ${genesisHash}`);
      }
      // Only the first message is noted, later ones would push the load's steps out of the breadcrumb trail.
      let answered = false;
      const connection = broker.connectRemote(
        genesisHash,
        `${scopeId} ${key}`,
        message => {
          if (!answered) {
            answered = true;
            note(`First chain message for ${connectionId} (${String(message.length)} bytes)`);
          }
          respond({ namespace: 'dotli:protocol', kind: 'chain-message', connectionId, message });
        },
        () => {
          // The broker has already answered pending requests and stopped follows. The client drops it on `chain-halt`.
          if (forget(key) === null) {
            return;
          }
          note(`Chain halted: ${connectionId} (${String(totalConnections())} remaining)`);
          respond({ namespace: 'dotli:protocol', kind: 'chain-halt', connectionId });
        },
      );
      if (connection === null) {
        throw new Error(PROTOCOL_APP_ERRORS.CHAIN_BROKER_FAILED);
      }
      connections.set(key, { genesisHash, connectionId, connection, respond });
      scopes.add(connections);
      note(`Chain connected: ${connectionId} (${String(totalConnections())} total)`);
      ok(respond, request.id, true);
    }

    async function handleRequest(
      request: ProtocolRequestEnvelope,
      origin: string,
      respond: ResponseCallback,
    ): Promise<void> {
      // The frame router sends these to the shared stores, so reaching here means a route is broken.
      if (
        isSharedAuthRequestMethod(request.method) ||
        isSharedModeRequestMethod(request.method) ||
        isSharedWalletRequestMethod(request.method)
      ) {
        throw new Error(`Shared storage request reached the chain engine: ${request.method}`);
      }
      const deadlineBudget = getRequestSyncTimeoutMs(request);
      const syncTimeoutMs =
        options.syncBudgetCapMs === undefined || deadlineBudget === undefined
          ? deadlineBudget
          : Math.min(deadlineBudget, options.syncBudgetCapMs);
      const syncOptions = syncTimeoutMs !== undefined ? { syncTimeoutMs } : {};

      switch (request.method) {
        case 'warmup': {
          if (options.onWarmup) {
            await options.onWarmup();
          }
          ok(respond, request.id, true);
          return;
        }

        case 'resolveDotName': {
          if (resolver === undefined) {
            throw new Error(PROTOCOL_APP_ERRORS.RESOLVE_DOT_NAME_UNSUPPORTED);
          }
          const payload = request.payload as ProtocolRequestMap['resolveDotName'];
          assertStr(payload.label, 'label');
          const result = await resolver.resolveDotName(payload.label, {
            onPhase: phase => {
              respond({ namespace: 'dotli:protocol', kind: 'progress', id: request.id, phase });
            },
            ...syncOptions,
          });
          ok(respond, request.id, result);
          return;
        }

        case 'resolveOwner': {
          if (resolver === undefined) {
            throw new Error(PROTOCOL_APP_ERRORS.RESOLVE_OWNER_UNSUPPORTED);
          }
          const payload = request.payload as ProtocolRequestMap['resolveOwner'];
          assertStr(payload.label, 'label');
          ok(respond, request.id, await resolver.resolveOwner(payload.label, syncOptions));
          return;
        }

        case 'resolveExecutableManifest': {
          if (resolver === undefined) {
            throw new Error(PROTOCOL_APP_ERRORS.RESOLVE_EXECUTABLE_MANIFEST_UNSUPPORTED);
          }
          const payload = request.payload as ProtocolRequestMap['resolveExecutableManifest'];
          assertStr(payload.label, 'label');
          // Widened to string so strict TS keeps the runtime check on this untrusted payload.
          const kind: string = payload.kind;
          if (!isExecutableKind(kind)) {
            throw new Error(`Unsupported executable kind: ${kind}`);
          }
          ok(respond, request.id, await resolver.resolveExecutableManifest(payload.label, payload.kind, syncOptions));
          return;
        }

        case 'resolveRootManifest': {
          if (resolver === undefined) {
            throw new Error(PROTOCOL_APP_ERRORS.RESOLVE_ROOT_MANIFEST_UNSUPPORTED);
          }
          const payload = request.payload as ProtocolRequestMap['resolveRootManifest'];
          assertStr(payload.label, 'label');
          ok(respond, request.id, await resolver.resolveRootManifest(payload.label, syncOptions));
          return;
        }

        case 'chainConnect': {
          connect(request, origin, respond);
          return;
        }

        case 'chainSend': {
          const payload = request.payload as ProtocolRequestMap['chainSend'];
          assertStr(payload.connectionId, 'connectionId');
          assertStr(payload.message, 'message');
          const held = connections.get(connectionKey(origin, payload.connectionId));
          if (held === undefined) {
            throw new Error(`Unknown chain connection: ${payload.connectionId}`);
          }
          held.connection.send(payload.message);
          ok(respond, request.id, true);
          return;
        }

        case 'chainDisconnect': {
          const payload = request.payload as ProtocolRequestMap['chainDisconnect'];
          assertStr(payload.connectionId, 'connectionId');
          const held = forget(connectionKey(origin, payload.connectionId));
          if (held !== null) {
            held.connection.disconnect();
            note(`Chain disconnected: ${payload.connectionId} (${String(totalConnections())} remaining)`);
          }
          ok(respond, request.id, true);
          return;
        }

        default: {
          const _method: never = request.method;
          throw new Error(`Unknown protocol method: ${_method as string}`);
        }
      }
    }

    function close(options: { halt?: boolean } = {}): number {
      let released = 0;
      for (const [key, held] of [...connections]) {
        // Forgotten first, so a halt this disconnect causes finds nothing left to report.
        forget(key);
        if (options.halt === true) {
          held.respond({ namespace: 'dotli:protocol', kind: 'chain-halt', connectionId: held.connectionId });
        }
        held.connection.disconnect();
        released += 1;
      }
      scopes.delete(connections);
      return released;
    }

    return { handleRequest, close };
  }

  function cleanup(): void {
    for (const connections of [...scopes]) {
      for (const held of connections.values()) {
        held.connection.disconnect();
      }
      connections.clear();
    }
    scopes.clear();
    broker.disconnectAll();
  }

  return { openScope, cleanup };
}
