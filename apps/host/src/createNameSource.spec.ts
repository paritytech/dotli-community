// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import type { Backend } from '@dotli/config';
import type { ResolveOptions, ResolvePhase } from '@dotli/resolver';
import { createNameSource, type RemoteResolver, type RpcResolver } from './createNameSource.js';

/** Contenthashes by name. A name missing here has none. */
type Names = Record<string, string>;

/** A backend, and the resolver that reads names on it. */
type BackendCase = {
  backend: Backend;
  resolver: 'remote' | 'rpc';
};

type Params = {
  names: Names;
};

const BACKEND_CASES: BackendCase[] = [
  { backend: 'smoldot-direct', resolver: 'remote' },
  { backend: 'rpc-gateway', resolver: 'rpc' },
];

describe('createNameSource', () => {
  it('As a visitor on a gateway, I read a name and its manifests at once and the gateway resolver loads once', async () => {
    // Given
    const rpc = createRpcResolver({ names: { doom: 'bafy-doom' } });
    const loadRpc = vi.fn(() => Promise.resolve(rpc));
    const names = createNameSource({ backend: 'rpc-gateway', remote: createRemoteResolver({ names: {} }), loadRpc });

    // When
    const [cid, manifests, worker] = await Promise.all([
      names.resolveProduct('doom'),
      names.readManifests('doom'),
      names.readWorkerManifest('doom'),
    ]);

    // Then
    expect(cid).toBe('bafy-doom');
    expect(manifests).toEqual({ root: { kind: 'empty' }, app: { kind: 'empty' } });
    expect(worker).toEqual({ kind: 'empty' });
    expect(loadRpc).toHaveBeenCalledTimes(1);
    expect(rpc.resolveExecutableManifest).toHaveBeenCalledWith('doom', 'worker');
  });

  it("As a visitor on a gateway, I read a name and hear the gateway resolver's phases for each name it asks", async () => {
    // Given
    const rpc = createRpcResolver({ names: { doom: 'bafy-doom' } });
    const names = createNameSource({
      backend: 'rpc-gateway',
      remote: createRemoteResolver({ names: {} }),
      loadRpc: () => Promise.resolve(rpc),
    });
    const phases: ResolvePhase[] = [];

    // When
    const cid = await names.resolveProduct('doom', { onPhase: phase => phases.push(phase) });

    // Then
    expect(cid).toBe('bafy-doom');
    expect(phases).toEqual(['resolving-content', 'resolving-content']);
  });

  it('As a visitor on a gateway, I read a name again after the resolver chunk failed to load and it loads again', async () => {
    // Given
    const rpc = createRpcResolver({ names: { doom: 'bafy-doom' } });
    const loadRpc = vi
      .fn<() => Promise<RpcResolver>>()
      .mockRejectedValueOnce(new Error('chunk failed'))
      .mockResolvedValue(rpc);
    const names = createNameSource({ backend: 'rpc-gateway', remote: createRemoteResolver({ names: {} }), loadRpc });

    // When
    const first = await names.resolveProduct('doom').catch((error: unknown) => error);
    const second = await names.resolveProduct('doom');

    // Then
    expect(first).toEqual(new Error('chunk failed'));
    expect(second).toBe('bafy-doom');
    expect(loadRpc).toHaveBeenCalledTimes(2);
  });

  it('As a visitor on a light client, I read names and manifests through the protocol frame and never load the gateway resolver', async () => {
    // Given
    const remote = createRemoteResolver({ names: { doom: 'bafy-doom' } });
    const loadRpc = vi.fn(() => Promise.resolve(createRpcResolver({ names: {} })));
    const names = createNameSource({ backend: 'smoldot-shared-worker', remote, loadRpc });
    const phases: ResolvePhase[] = [];

    // When
    const cid = await names.resolveProduct('doom', { onPhase: phase => phases.push(phase) });
    await names.readManifests('doom');
    await names.readWorkerManifest('doom');

    // Then
    expect(cid).toBe('bafy-doom');
    expect(phases).toEqual(['asset-hub-syncing', 'asset-hub-syncing']);
    expect(remote.resolveExecutableManifest).toHaveBeenCalledWith('doom', 'app');
    expect(remote.resolveExecutableManifest).toHaveBeenCalledWith('doom', 'worker');
    expect(loadRpc).not.toHaveBeenCalled();
  });

  it.each(BACKEND_CASES)(
    'As a visitor on $backend, I open two products and get the app subname content where there is one and the base name content otherwise',
    async ({ backend, resolver }) => {
      // Given
      const published = { 'app.doom': 'bafy-app', quake: 'bafy-quake' };
      const resolvers = {
        remote: createRemoteResolver({ names: published }),
        rpc: createRpcResolver({ names: published }),
      };
      const names = createNameSource({
        backend,
        remote: resolvers.remote,
        loadRpc: () => Promise.resolve(resolvers.rpc),
      });

      // When
      const withSubname = await names.resolveProduct('doom');
      const withoutSubname = await names.resolveProduct('quake');

      // Then
      expect(withSubname).toBe('bafy-app');
      expect(withoutSubname).toBe('bafy-quake');
      expect(resolvers[resolver].asked).toEqual(['app.doom', 'app.quake', 'quake']);
    },
  );

  it.each(BACKEND_CASES)(
    'As a visitor on $backend, I open a product published under both its app subname and its base name and get the app subname content',
    async ({ backend, resolver }) => {
      // Given
      const published = { 'app.doom': 'bafy-app', doom: 'bafy-base' };
      const resolvers = {
        remote: createRemoteResolver({ names: published }),
        rpc: createRpcResolver({ names: published }),
      };
      const names = createNameSource({
        backend,
        remote: resolvers.remote,
        loadRpc: () => Promise.resolve(resolvers.rpc),
      });

      // When
      const cid = await names.resolveProduct('doom');

      // Then
      expect(cid).toBe('bafy-app');
      expect(resolvers[resolver].asked).toEqual(['app.doom']);
    },
  );
});

function createRemoteResolver({ names }: Params): RemoteResolver & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    resolveDotName: vi.fn((name: string, onPhase?: (phase: ResolvePhase) => void) => {
      asked.push(name);
      onPhase?.('asset-hub-syncing');
      return Promise.resolve(names[name] ?? null);
    }),
    resolveRootManifest: vi.fn(() => Promise.resolve({ kind: 'empty' as const })),
    resolveExecutableManifest: vi.fn(() => Promise.resolve({ kind: 'empty' as const })),
  };
}

function createRpcResolver({ names }: Params): RpcResolver & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    resolveDotName: vi.fn((name: string, options?: ResolveOptions) => {
      asked.push(name);
      options?.onPhase?.('resolving-content');
      return Promise.resolve(names[name] ?? null);
    }),
    resolveRootManifest: vi.fn(() => Promise.resolve({ kind: 'empty' as const })),
    resolveExecutableManifest: vi.fn(() => Promise.resolve({ kind: 'empty' as const })),
  };
}
