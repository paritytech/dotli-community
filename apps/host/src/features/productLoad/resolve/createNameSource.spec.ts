// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import type { Backend } from '@dotli/config';
import type { ExecutableManifest, ManifestResult, ResolveOptions, ResolvePhase } from '@dotli/resolver';
import { createNameSource, type RemoteResolver, type RpcResolver } from './createNameSource.js';
import { parseH160Address } from '../../../kit/h160Address.js';

/** Contenthashes by name. A name missing here has none. */
type Names = Record<string, string>;

/** A backend, and the resolver that reads names on it. */
type BackendCase = {
  backend: Backend;
  resolver: 'remote' | 'rpc';
};

type Params = {
  names: Names;
  /** Owner addresses by label. A label missing here has none. */
  owners?: Record<string, string>;
  /** The error every owner read rejects with, in place of `owners`. */
  ownerError?: Error;
  /** Primary names by address. An address missing here has none. */
  primaryNames?: Record<string, string>;
  /** Worker manifests by label. A label missing here has none. */
  workers?: Record<string, ManifestResult<ExecutableManifest>>;
};

const OWNER = `0x${'ab'.repeat(20)}`;

const WORKER_MANIFEST: ManifestResult<ExecutableManifest> = {
  kind: 'ok',
  value: { $v: 1, appVersion: [1, 0, 0], kind: 'worker', entrypoint: 'index.js', includes: { chat: true } },
  raw: '',
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
      names.readWorkerExecutable('doom'),
    ]);

    // Then
    expect(cid).toBe('bafy-doom');
    expect(manifests).toEqual({ root: { kind: 'empty' }, app: { kind: 'empty' }, owner: null });
    expect(worker).toBeNull();
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
    await names.readWorkerExecutable('doom');

    // Then
    expect(cid).toBe('bafy-doom');
    expect(phases).toEqual(['asset-hub-syncing', 'asset-hub-syncing']);
    expect(remote.resolveExecutableManifest).toHaveBeenCalledWith('doom', 'app');
    expect(remote.resolveExecutableManifest).toHaveBeenCalledWith('doom', 'worker');
    expect(loadRpc).not.toHaveBeenCalled();
  });

  it.each(BACKEND_CASES)(
    'As a visitor on $backend, I open a product that publishes a worker and get its entrypoint, its includes and the CID of its worker subname',
    async ({ backend }) => {
      // Given
      const published = { names: { 'worker.doom': 'bafy-worker' }, workers: { doom: WORKER_MANIFEST } };
      const names = createNameSource({
        backend,
        remote: createRemoteResolver(published),
        loadRpc: () => Promise.resolve(createRpcResolver(published)),
      });

      // When
      const worker = await names.readWorkerExecutable('doom');

      // Then
      expect(worker).toEqual({ entrypoint: 'index.js', includes: { chat: true }, cid: 'bafy-worker' });
    },
  );

  it.each<[string, Params]>([
    ['no worker manifest', { names: { 'worker.doom': 'bafy-worker' } }],
    [
      'an invalid worker manifest',
      {
        names: { 'worker.doom': 'bafy-worker' },
        workers: { doom: { kind: 'invalid', errors: ['entrypoint'], raw: '{}' } },
      },
    ],
    ['a worker manifest with no contenthash', { names: {}, workers: { doom: WORKER_MANIFEST } }],
  ])('As a visitor, I open a product with %s and it has no worker', async (_name, published) => {
    // Given
    const names = createNameSource({
      backend: 'smoldot-direct',
      remote: createRemoteResolver(published),
      loadRpc: () => Promise.resolve(createRpcResolver(published)),
    });

    // When
    const worker = await names.readWorkerExecutable('doom');

    // Then
    expect(worker).toBeNull();
  });

  it('As a visitor, I read a product worker twice in one page, once while the first read runs and once after, and dotNS is read once', async () => {
    // Given
    const remote = createRemoteResolver({
      names: { 'worker.doom': 'bafy-worker' },
      workers: { doom: WORKER_MANIFEST },
    });
    const names = createNameSource({
      backend: 'smoldot-direct',
      remote,
      loadRpc: () => Promise.resolve(createRpcResolver({ names: {} })),
    });

    // When
    const [load, overlapping] = await Promise.all([
      names.readWorkerExecutable('doom'),
      names.readWorkerExecutable('doom'),
    ]);
    const later = await names.readWorkerExecutable('doom');

    // Then
    expect(overlapping).toBe(load);
    expect(later).toBe(load);
    expect(remote.asked).toEqual(['worker.doom']);
    expect(remote.resolveExecutableManifest).toHaveBeenCalledOnce();
  });

  it('As a visitor, I read a product worker again after its read failed and it is read again', async () => {
    // Given
    const remote = createRemoteResolver({
      names: { 'worker.doom': 'bafy-worker' },
      workers: { doom: WORKER_MANIFEST },
    });
    vi.mocked(remote.resolveExecutableManifest).mockRejectedValueOnce(new Error('offline'));
    const names = createNameSource({
      backend: 'smoldot-direct',
      remote,
      loadRpc: () => Promise.resolve(createRpcResolver({ names: {} })),
    });

    // When
    const first = await names.readWorkerExecutable('doom').catch((error: unknown) => error);
    const second = await names.readWorkerExecutable('doom');

    // Then
    expect(first).toEqual(new Error('offline'));
    expect(second).toEqual({ entrypoint: 'index.js', includes: { chat: true }, cid: 'bafy-worker' });
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

  it.each(BACKEND_CASES)(
    "As a visitor on $backend, I open a product and its manifests come with its owner's address, read by the resolver that backend uses",
    async ({ backend, resolver }) => {
      // Given a name registered to an owner, with both resolvers able to answer
      const owners = { doom: OWNER };
      const resolvers = {
        remote: createRemoteResolver({ names: {}, owners }),
        rpc: createRpcResolver({ names: {}, owners }),
      };
      const names = createNameSource({
        backend,
        remote: resolvers.remote,
        loadRpc: () => Promise.resolve(resolvers.rpc),
      });
      const other = resolver === 'remote' ? 'rpc' : 'remote';

      // When the manifests are read
      const manifests = await names.readManifests('doom');

      // Then the owner comes from the resolver this backend uses, and the other one is not asked
      expect(manifests).toEqual({ root: { kind: 'empty' }, app: { kind: 'empty' }, owner: parseH160Address(OWNER) });
      expect(resolvers[resolver].asked).toEqual(['doom']);
      expect(resolvers[other].asked).toEqual([]);
    },
  );

  it.each(BACKEND_CASES)(
    "As a visitor on $backend, I open the card of a product and read its owner's primary name through the resolver that backend uses",
    async ({ backend, resolver }) => {
      // Given an owner address that stored a primary name, with both resolvers able to answer
      const primaryNames = { [OWNER]: 'alice.dot' };
      const resolvers = {
        remote: createRemoteResolver({ names: {}, primaryNames }),
        rpc: createRpcResolver({ names: {}, primaryNames }),
      };
      const names = createNameSource({
        backend,
        remote: resolvers.remote,
        loadRpc: () => Promise.resolve(resolvers.rpc),
      });
      const other = resolver === 'remote' ? 'rpc' : 'remote';

      // When the primary name is read
      const name = await names.readPrimaryName(parseH160Address(OWNER));

      // Then the name comes from the resolver this backend uses, and the other one is not asked
      expect(name).toBe('alice.dot');
      expect(resolvers[resolver].asked).toEqual([OWNER]);
      expect(resolvers[other].asked).toEqual([]);
    },
  );

  it.each(BACKEND_CASES)(
    'As a visitor on $backend, I open a product whose name has no owner and its manifests say so',
    async ({ backend }) => {
      // Given a name with no owner
      const names = createNameSource({
        backend,
        remote: createRemoteResolver({ names: {} }),
        loadRpc: () => Promise.resolve(createRpcResolver({ names: {} })),
      });

      // When the manifests are read
      const manifests = await names.readManifests('doom');

      // Then the manifests carry a null owner
      expect(manifests.owner).toBeNull();
    },
  );

  it.each(BACKEND_CASES)(
    'As a visitor on $backend, I open a product whose owner cannot be read and still get its manifests, with the failure reported',
    async ({ backend }) => {
      // Given an owner read that rejects
      const ownerError = new Error('dotNS owner slot unreadable');
      const heard: unknown[] = [];
      const names = createNameSource({
        backend,
        remote: createRemoteResolver({ names: {}, ownerError }),
        loadRpc: () => Promise.resolve(createRpcResolver({ names: {}, ownerError })),
        report: error => {
          heard.push(error);
        },
      });

      // When the manifests are read
      const manifests = await names.readManifests('doom');

      // Then the manifests answer with no owner field, and the report heard the error
      expect(manifests).toStrictEqual({ root: { kind: 'empty' }, app: { kind: 'empty' } });
      expect(heard).toEqual([ownerError]);
    },
  );

  it.each(BACKEND_CASES)(
    'As a visitor on $backend, I open a product whose resolver answers its owner with no 20-byte hex address and get its manifests without one, with the answer reported',
    async ({ backend }) => {
      // Given a resolver that answers the owner with an account that is not an address
      const owners = { doom: '5Owner' };
      const heard: unknown[] = [];
      const names = createNameSource({
        backend,
        remote: createRemoteResolver({ names: {}, owners }),
        loadRpc: () => Promise.resolve(createRpcResolver({ names: {}, owners })),
        report: error => {
          heard.push(error);
        },
      });

      // When the manifests are read
      const manifests = await names.readManifests('doom');

      // Then the manifests answer with no owner field, and the report heard a parse error that names the answer
      expect(manifests).toStrictEqual({ root: { kind: 'empty' }, app: { kind: 'empty' } });
      expect(heard).toEqual([new Error('Address 5Owner is not a 20-byte hex address')]);
    },
  );
});

function createRemoteResolver({
  names,
  owners = {},
  ownerError,
  primaryNames = {},
  workers = {},
}: Params): RemoteResolver & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    resolveOwner: vi.fn((label: string) => {
      asked.push(label);
      return ownerError === undefined ? Promise.resolve(owners[label] ?? null) : Promise.reject(ownerError);
    }),
    resolvePrimaryName: vi.fn((address: string) => {
      asked.push(address);
      return Promise.resolve(primaryNames[address] ?? null);
    }),
    resolveDotName: vi.fn((name: string, onPhase?: (phase: ResolvePhase) => void) => {
      asked.push(name);
      onPhase?.('asset-hub-syncing');
      return Promise.resolve(names[name] ?? null);
    }),
    resolveRootManifest: vi.fn(() => Promise.resolve({ kind: 'empty' as const })),
    resolveExecutableManifest: vi.fn((label: string, kind: string) =>
      Promise.resolve<ManifestResult<ExecutableManifest>>(
        (kind === 'worker' ? workers[label] : undefined) ?? { kind: 'empty' },
      ),
    ),
  };
}

function createRpcResolver({
  names,
  owners = {},
  ownerError,
  primaryNames = {},
  workers = {},
}: Params): RpcResolver & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    resolveOwner: vi.fn((label: string) => {
      asked.push(label);
      return ownerError === undefined ? Promise.resolve(owners[label] ?? null) : Promise.reject(ownerError);
    }),
    resolvePrimaryName: vi.fn((address: string) => {
      asked.push(address);
      return Promise.resolve(primaryNames[address] ?? null);
    }),
    resolveDotName: vi.fn((name: string, options?: ResolveOptions) => {
      asked.push(name);
      options?.onPhase?.('resolving-content');
      return Promise.resolve(names[name] ?? null);
    }),
    resolveRootManifest: vi.fn(() => Promise.resolve({ kind: 'empty' as const })),
    resolveExecutableManifest: vi.fn((label: string, kind: string) =>
      Promise.resolve<ManifestResult<ExecutableManifest>>(
        (kind === 'worker' ? workers[label] : undefined) ?? { kind: 'empty' },
      ),
    ),
  };
}
