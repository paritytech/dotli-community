// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished, vi, type Mock } from 'vitest';
import type { JsonRpcConnection, JsonRpcProvider } from '@polkadot-api/json-rpc-provider';
import { NETWORK_NAME_TO_SERVICES_CONFIG } from '@dotli/config';
import { createChainPool, type ChainPool, type ChainTransportHooks, type LightClient } from '@dotli/chains';
import { must } from '@dotli/shared/testing';
import { observeChains, startLightClientService, type LightClientResolver } from './light-client-service.js';

const services = NETWORK_NAME_TO_SERVICES_CONFIG['paseo-next-v2'];

type ResolverDeps = Parameters<LightClientResolver['createDotnsResolver']>[0];

/** A light client and resolver that record what the service opened, in order. */
function fakes() {
  const events: string[] = [];
  let resolverDeps: ResolverDeps | null = null;
  const lightClient: LightClient = {
    createChainProvider: genesisHash => {
      events.push(`open ${genesisHash}`);
      return (): JsonRpcConnection => ({ send: () => undefined, disconnect: () => undefined });
    },
    isChainSupported: () => true,
    status: () => ({ fatal: null, db: new Map() }),
    subscribe: () => () => undefined,
  };
  const resolver: LightClientResolver = {
    enableSyncReporting: chains => {
      events.push(`report ${chains.join(',')}`);
    },
    createDotnsResolver: deps => {
      resolverDeps = deps;
      return {} as ReturnType<LightClientResolver['createDotnsResolver']>;
    },
  };
  return { lightClient, resolver, events, resolverDeps: () => must(resolverDeps, 'resolver deps') };
}

describe('startLightClientService', () => {
  it('As a dotli user in either light client mode, the relay and Bulletin sync shows before any product asks for them', () => {
    // Given
    const { lightClient, resolver, events } = fakes();

    // When
    startLightClientService({ lightClient, resolver, services });

    // Then sync reporting is on before the first chain opens, which then carries its lifecycle watch
    expect(events).toEqual([
      'report relay,assethub,bulletin,people',
      `open ${services.relay.genesis}`,
      `open ${services.bulletin.genesis}`,
    ]);
  });

  it("As a dotli user in either light client mode, names resolve over the light client's own Asset Hub and People follows", () => {
    // Given
    const { lightClient, resolver, events, resolverDeps } = fakes();
    startLightClientService({ lightClient, resolver, services });

    // When
    resolverDeps().assetHub()(() => undefined);
    must(resolverDeps().people, 'people')()(() => undefined);

    // Then
    expect(events.slice(3)).toEqual([`open ${services.assethub.genesis}`, `open ${services.people.genesis}`]);
    expect(resolverDeps().dotns).toEqual(services.dotns);
  });
});

interface Built {
  genesisHash: string;
  disconnect: Mock<() => void>;
  /** The transport halts for good. */
  halt: (error: unknown) => void;
}

function setup(destroyDelay: number, unsupported: readonly string[] = []): { pool: ChainPool; built: Built[] } {
  const built: Built[] = [];
  const createTransport = (genesisHash: string, hooks: ChainTransportHooks): JsonRpcProvider | null => {
    if (unsupported.includes(genesisHash)) {
      return null;
    }
    const record: Built = {
      genesisHash,
      disconnect: vi.fn<() => void>(),
      halt: error => {
        hooks.onHalt(error);
      },
    };
    built.push(record);
    return (): JsonRpcConnection => ({
      send() {
        /* requests are not under test */
      },
      disconnect: record.disconnect,
    });
  };
  return { pool: createChainPool({ createTransport, destroyDelay }), built };
}

describe('observeChains', () => {
  it('As a dotli user on a light client, I see the watched chains opened once and kept', () => {
    // Given
    const { pool, built } = setup(0);

    // When: a dApp connects to a watched chain and leaves.
    observeChains(pool, ['0xaa', '0xbb']);
    pool.connectRemote('0xbb', 'c1', () => undefined)?.disconnect();

    // Then
    expect(built.map(b => b.genesisHash)).toEqual(['0xaa', '0xbb']);
    expect(built.map(b => b.disconnect.mock.calls.length)).toEqual([0, 0]);
  });

  it('As a dotli integrator, I stop the watch and its leases are released', () => {
    // Given
    const { pool, built } = setup(0);
    const stop = observeChains(pool, ['0xaa', '0xbb']);

    // When
    stop();
    stop();

    // Then
    expect(built.map(b => b.disconnect.mock.calls.length)).toEqual([1, 1]);
  });

  it('As a dotli user on a network without a chain, I see the watch skip it', () => {
    // Given
    const { pool, built } = setup(0, ['0xaa']);

    // When
    const stop = observeChains(pool, ['0xaa', '0xbb']);

    // Then
    expect(built.map(b => b.genesisHash)).toEqual(['0xbb']);
    expect(() => {
      stop();
    }).not.toThrow();
    expect(built.map(b => b.disconnect.mock.calls.length)).toEqual([1]);
  });

  it('As a dotli user on a light client, I keep seeing the sync of a chain whose transport halted, on the chain the pool rebuilds', () => {
    // Given
    const { pool, built } = setup(0);
    observeChains(pool, ['0xaa', '0xbb'], 0);

    // When
    built[0]?.halt(new Error('gone'));

    // Then
    expect(built.map(b => b.genesisHash)).toEqual(['0xaa', '0xbb', '0xaa']);
    expect(built[2]?.disconnect).not.toHaveBeenCalled();
  });

  it('As a dotli user on a light client, I keep seeing the sync of a chain that halts again after it was rebuilt', async () => {
    // Given
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const { pool, built } = setup(0);
    observeChains(pool, ['0xaa'], 1_000);
    built[0]?.halt(new Error('gone'));
    await vi.advanceTimersByTimeAsync(1_000);

    // When
    built[1]?.halt(new Error('gone again'));
    await vi.advanceTimersByTimeAsync(1_000);

    // Then
    expect(built.map(b => b.genesisHash)).toEqual(['0xaa', '0xaa', '0xaa']);
  });

  it('As a dotli integrator, I see one new lease when a chain reports its halt twice', async () => {
    // Given
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const { pool, built } = setup(0);
    observeChains(pool, ['0xaa'], 1_000);

    // When
    built[0]?.halt(new Error('gone'));
    built[0]?.halt(new Error('gone'));
    await vi.advanceTimersByTimeAsync(1_000);

    // Then
    expect(built.map(b => b.genesisHash)).toEqual(['0xaa', '0xaa']);
  });

  it('As a dotli integrator, I see a halted chain taken again only once the re-take delay has passed', async () => {
    // Given
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const { pool, built } = setup(0);
    observeChains(pool, ['0xaa'], 1_000);

    // When
    built[0]?.halt(new Error('gone'));
    const beforeDelay = built.length;
    await vi.advanceTimersByTimeAsync(1_000);

    // Then
    expect(beforeDelay).toBe(1);
    expect(built.map(b => b.genesisHash)).toEqual(['0xaa', '0xaa']);
  });

  it('As a dotli integrator, I stop the watch while a halted chain waits to be taken again and it is not reopened', async () => {
    // Given
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const { pool, built } = setup(0);
    const stop = observeChains(pool, ['0xaa'], 1_000);
    built[0]?.halt(new Error('gone'));

    // When
    stop();
    await vi.advanceTimersByTimeAsync(1_000);

    // Then
    expect(built.map(b => b.genesisHash)).toEqual(['0xaa']);
  });
});
