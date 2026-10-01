// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The protocol iframe's request engine: resolution, warmup and remote chain connections.

import type { JsonRpcProvider } from '@polkadot-api/json-rpc-provider';
import type { StringJsonRpcConnection } from '@dotli/protocol';
import type {
  ChainTransportHooks,
  ExecutableManifest,
  ManifestResult,
  RootManifest,
  ResolveOptions,
} from '@dotli/resolver';
import { isExecutableKind } from '@dotli/shared';
import {
  createChainPool,
  type ChainBrokerManager,
  isSharedAuthRequestMethod,
  isSharedModeRequestMethod,
  getRequestSyncTimeoutMs,
  type ProtocolEnvelope,
  type ProtocolRequestEnvelope,
  type ProtocolRequestMap,
} from '@dotli/protocol';

import { PROTOCOL_APP_ERRORS } from './errors.js';

export type ResponseCallback = (envelope: ProtocolEnvelope) => void;

export interface ProtocolEngine {
  handleRequest: (request: ProtocolRequestEnvelope, origin: string, respond: ResponseCallback) => Promise<void>;
  cleanup: () => void;
}

export interface EngineOptions {
  /** Factory for a chain's transport, keyed by genesis hash. */
  createChainProvider: (genesisHash: string, hooks?: ChainTransportHooks) => JsonRpcProvider | null;
  /** How long a chain outlives its last connection, in ms (`Infinity` keeps it). */
  destroyDelay: number;
  /** Whether the given genesis hash is handled by this engine. */
  isChainSupported: (genesisHash: string) => boolean;
  /**
   * Called once right after the broker is created. Smoldot modes use this to
   * route the resolver's Asset Hub reads through the broker's shared follow.
   */
  onBrokerReady?: (broker: ChainBrokerManager) => void;
  /** Called on `warmup` requests. If omitted, `warmup` resolves immediately. */
  onWarmup?: () => Promise<void>;
  /** Resolver implementations. If omitted, resolution methods reject with a
   *  clear error so hanging callers surface fast. Signatures mirror the
   *  `@dotli/resolver` entry points so they can be wired by reference. */
  resolveDotName?: (label: string, opts?: ResolveOptions) => Promise<string | null>;
  resolveOwner?: (label: string, opts?: ResolveOptions) => Promise<string | null>;
  /**
   * Product-manifest readers.
   *
   * `rpc-gateway` mode resolves manifests in the host process, not via the
   * iframe engine, so these stay unwired there.
   */
  resolveExecutableManifest?: (
    label: string,
    kind: 'app' | 'widget' | 'worker',
    opts?: ResolveOptions,
  ) => Promise<ManifestResult<ExecutableManifest>>;
  resolveRootManifest?: (label: string, opts?: ResolveOptions) => Promise<ManifestResult<RootManifest>>;
}

/** Chain connections one protocol iframe holds: one tab's budget. */
export const MAX_CONNS = 10;

export function createEngine(options: EngineOptions): ProtocolEngine {
  const connections = new Map<string, StringJsonRpcConnection>();
  const broker = createChainPool({
    createTransport: options.createChainProvider,
    destroyDelay: options.destroyDelay,
  });
  options.onBrokerReady?.(broker);

  /** Connection ids are the client's own, so each origin has its own namespace (origins contain no spaces). */
  function connectionKey(origin: string, connectionId: string): string {
    return `${origin} ${connectionId}`;
  }

  /** Drop a connection from the engine's books, freeing its slot. */
  function forget(key: string): StringJsonRpcConnection | null {
    const connection = connections.get(key);
    connections.delete(key);
    return connection ?? null;
  }

  function assertStr(value: unknown, name: string): asserts value is string {
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`Invalid ${name}: expected non-empty string`);
    }
  }

  async function handleRequest(
    request: ProtocolRequestEnvelope,
    origin: string,
    respond: ResponseCallback,
  ): Promise<void> {
    // Both engine-facing listeners filter shared-auth/shared-mode out;
    // reaching the engine means one of those filters is broken.
    if (isSharedAuthRequestMethod(request.method) || isSharedModeRequestMethod(request.method)) {
      throw new Error(`Shared storage request reached the chain engine: ${request.method}`);
    }

    const syncTimeoutMs = getRequestSyncTimeoutMs(request);
    const syncOptions = syncTimeoutMs !== undefined ? { syncTimeoutMs } : {};

    switch (request.method) {
      case 'warmup': {
        if (options.onWarmup) {
          await options.onWarmup();
        }
        respond({
          namespace: 'dotli:protocol',
          kind: 'response',
          id: request.id,
          ok: true,
          result: true,
        });
        return;
      }

      case 'resolveDotName': {
        if (!options.resolveDotName) {
          throw new Error(PROTOCOL_APP_ERRORS.RESOLVE_DOT_NAME_UNSUPPORTED);
        }
        const payload = request.payload as ProtocolRequestMap['resolveDotName'];
        assertStr(payload.label, 'label');
        const result = await options.resolveDotName(payload.label, {
          onStatus: message => {
            respond({
              namespace: 'dotli:protocol',
              kind: 'progress',
              id: request.id,
              message,
            });
          },
          ...syncOptions,
        });
        respond({
          namespace: 'dotli:protocol',
          kind: 'response',
          id: request.id,
          ok: true,
          result,
        });
        return;
      }

      case 'resolveOwner': {
        if (!options.resolveOwner) {
          throw new Error(PROTOCOL_APP_ERRORS.RESOLVE_OWNER_UNSUPPORTED);
        }
        const payload = request.payload as ProtocolRequestMap['resolveOwner'];
        assertStr(payload.label, 'label');
        const result = await options.resolveOwner(payload.label, syncOptions);
        respond({
          namespace: 'dotli:protocol',
          kind: 'response',
          id: request.id,
          ok: true,
          result,
        });
        return;
      }

      case 'resolveExecutableManifest': {
        if (!options.resolveExecutableManifest) {
          throw new Error(PROTOCOL_APP_ERRORS.RESOLVE_EXECUTABLE_MANIFEST_UNSUPPORTED);
        }
        const payload = request.payload as ProtocolRequestMap['resolveExecutableManifest'];
        assertStr(payload.label, 'label');
        const kind: string = payload.kind;
        if (!isExecutableKind(kind)) {
          throw new Error(`Unsupported executable kind: ${kind}`);
        }
        const result = await options.resolveExecutableManifest(payload.label, payload.kind, syncOptions);
        respond({
          namespace: 'dotli:protocol',
          kind: 'response',
          id: request.id,
          ok: true,
          result,
        });
        return;
      }

      case 'resolveRootManifest': {
        if (!options.resolveRootManifest) {
          throw new Error(PROTOCOL_APP_ERRORS.RESOLVE_ROOT_MANIFEST_UNSUPPORTED);
        }
        const payload = request.payload as ProtocolRequestMap['resolveRootManifest'];
        assertStr(payload.label, 'label');
        const result = await options.resolveRootManifest(payload.label, syncOptions);
        respond({
          namespace: 'dotli:protocol',
          kind: 'response',
          id: request.id,
          ok: true,
          result,
        });
        return;
      }

      case 'chainConnect': {
        const payload = request.payload as ProtocolRequestMap['chainConnect'];
        assertStr(payload.genesisHash, 'genesisHash');
        assertStr(payload.connectionId, 'connectionId');
        const key = connectionKey(origin, payload.connectionId);
        if (connections.has(key)) {
          throw new Error(`Duplicate chain connection: ${payload.connectionId}`);
        }
        if (connections.size >= MAX_CONNS) {
          throw new Error(`Connection limit reached (max ${String(MAX_CONNS)})`);
        }
        if (!options.isChainSupported(payload.genesisHash)) {
          throw new Error(`Unsupported chain: ${payload.genesisHash}`);
        }
        const { connectionId } = payload;
        const connection = broker.connectRemote(
          payload.genesisHash,
          key,
          message => {
            respond({
              namespace: 'dotli:protocol',
              kind: 'chain-message',
              connectionId,
              message,
            });
          },
          () => {
            // The broker has answered this connection's pending requests and
            // stopped its follows by now; the client drops it on `chain-halt`.
            if (forget(key) === null) {
              return;
            }
            respond({ namespace: 'dotli:protocol', kind: 'chain-halt', connectionId });
          },
        );
        if (connection === null) {
          throw new Error(PROTOCOL_APP_ERRORS.CHAIN_BROKER_FAILED);
        }
        connections.set(key, connection);
        respond({
          namespace: 'dotli:protocol',
          kind: 'response',
          id: request.id,
          ok: true,
          result: true,
        });
        return;
      }

      case 'chainSend': {
        const payload = request.payload as ProtocolRequestMap['chainSend'];
        assertStr(payload.connectionId, 'connectionId');
        assertStr(payload.message, 'message');
        const conn = connections.get(connectionKey(origin, payload.connectionId));
        if (conn === undefined) {
          throw new Error(`Unknown chain connection: ${payload.connectionId}`);
        }
        conn.send(payload.message);
        respond({
          namespace: 'dotli:protocol',
          kind: 'response',
          id: request.id,
          ok: true,
          result: true,
        });
        return;
      }

      case 'chainDisconnect': {
        const payload = request.payload as ProtocolRequestMap['chainDisconnect'];
        assertStr(payload.connectionId, 'connectionId');
        forget(connectionKey(origin, payload.connectionId))?.disconnect();
        respond({
          namespace: 'dotli:protocol',
          kind: 'response',
          id: request.id,
          ok: true,
          result: true,
        });
        return;
      }

      default: {
        const _method: never = request.method;
        throw new Error(`Unknown protocol method: ${_method as string}`);
      }
    }
  }

  function cleanup(): void {
    for (const connection of connections.values()) {
      connection.disconnect();
    }
    connections.clear();
    broker.disconnectAll();
  }

  return { handleRequest, cleanup };
}
