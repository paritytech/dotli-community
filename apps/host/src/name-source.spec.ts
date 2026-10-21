// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import type { Backend } from '@dotli/config';
import type { ResolveOptions, ResolvePhase } from '@dotli/resolver';
import { createNameSource, type RemoteResolver, type RpcResolver } from './name-source.js';

/** Contenthashes by name. A name missing here has none. */
type Names = Record<string, string>;

function remoteResolver(names: Names): RemoteResolver & { asked: string[] } {
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

function rpcResolver(names: Names): RpcResolver & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    resolveDotName: vi.fn((name: string, opts?: ResolveOptions) => {
      asked.push(name);
      opts?.onPhase?.('resolving-content');
      return Promise.resolve(names[name] ?? null);
    }),
    resolveRootManifest: vi.fn(() => Promise.resolve({ kind: 'empty' as const })),
    resolveExecutableManifest: vi.fn(() => Promise.resolve({ kind: 'empty' as const })),
  };
}

describe('createNameSource', () => {
  it('As a visitor on a gateway, I read a name and its manifests at once and the gateway resolver loads once', async () => {
    // Given
    const rpc = rpcResolver({ doom: 'bafy-doom' });
    const loadRpc = vi.fn(() => Promise.resolve(rpc));
    const names = createNameSource({ backend: 'rpc-gateway', remote: remoteResolver({}), loadRpc });

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

  it("As a visitor on a gateway, I hear the gateway resolver's phases for each name it reads", async () => {
    // Given
    const rpc = rpcResolver({ doom: 'bafy-doom' });
    const names = createNameSource({
      backend: 'rpc-gateway',
      remote: remoteResolver({}),
      loadRpc: () => Promise.resolve(rpc),
    });
    const phases: ResolvePhase[] = [];

    // When
    const cid = await names.resolveProduct('doom', phase => phases.push(phase));

    // Then
    expect(cid).toBe('bafy-doom');
    expect(phases).toEqual(['resolving-content', 'resolving-content']);
  });

  it('As a visitor on a gateway, I get the resolver chunk loaded again after a failed load', async () => {
    // Given
    const rpc = rpcResolver({ doom: 'bafy-doom' });
    const loadRpc = vi
      .fn<() => Promise<RpcResolver>>()
      .mockRejectedValueOnce(new Error('chunk failed'))
      .mockResolvedValue(rpc);
    const names = createNameSource({ backend: 'rpc-gateway', remote: remoteResolver({}), loadRpc });

    // When
    const first = await names.resolveProduct('doom').catch((err: unknown) => err);
    const second = await names.resolveProduct('doom');

    // Then
    expect(first).toEqual(new Error('chunk failed'));
    expect(second).toBe('bafy-doom');
    expect(loadRpc).toHaveBeenCalledTimes(2);
  });

  it('As a visitor on a light client, I read names and manifests through the protocol frame and never load the gateway resolver', async () => {
    // Given
    const remote = remoteResolver({ doom: 'bafy-doom' });
    const loadRpc = vi.fn(() => Promise.resolve(rpcResolver({})));
    const names = createNameSource({ backend: 'smoldot-shared-worker', remote, loadRpc });
    const phases: ResolvePhase[] = [];

    // When
    const cid = await names.resolveProduct('doom', phase => phases.push(phase));
    await names.readManifests('doom');
    await names.readWorkerManifest('doom');

    // Then
    expect(cid).toBe('bafy-doom');
    expect(phases).toEqual(['asset-hub-syncing', 'asset-hub-syncing']);
    expect(remote.resolveExecutableManifest).toHaveBeenCalledWith('doom', 'app');
    expect(remote.resolveExecutableManifest).toHaveBeenCalledWith('doom', 'worker');
    expect(loadRpc).not.toHaveBeenCalled();
  });

  it.each<Backend>(['smoldot-direct', 'rpc-gateway'])(
    'As a visitor on %s, I get the app subname content when it has one, and the base name content otherwise',
    async backend => {
      // Given
      const published = { 'app.doom': 'bafy-app', quake: 'bafy-quake' };
      const remote = remoteResolver(published);
      const rpc = rpcResolver(published);
      const names = createNameSource({ backend, remote, loadRpc: () => Promise.resolve(rpc) });

      // When
      const withSubname = await names.resolveProduct('doom');
      const withoutSubname = await names.resolveProduct('quake');

      // Then
      expect(withSubname).toBe('bafy-app');
      expect(withoutSubname).toBe('bafy-quake');
      expect(backend === 'rpc-gateway' ? rpc.asked : remote.asked).toEqual(['app.doom', 'app.quake', 'quake']);
    },
  );

  it.each<Backend>(['smoldot-direct', 'rpc-gateway'])(
    'As a visitor on %s to a product published under both its app subname and its base name, I get the app subname content',
    async backend => {
      // Given
      const published = { 'app.doom': 'bafy-app', doom: 'bafy-base' };
      const remote = remoteResolver(published);
      const rpc = rpcResolver(published);
      const names = createNameSource({ backend, remote, loadRpc: () => Promise.resolve(rpc) });

      // When
      const cid = await names.resolveProduct('doom');

      // Then
      expect(cid).toBe('bafy-app');
      expect(backend === 'rpc-gateway' ? rpc.asked : remote.asked).toEqual(['app.doom']);
    },
  );
});
