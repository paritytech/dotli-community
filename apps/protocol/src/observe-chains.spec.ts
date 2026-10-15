// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished, vi, type Mock } from 'vitest';
import type { JsonRpcConnection, JsonRpcProvider } from '@polkadot-api/json-rpc-provider';
import { createChainPool, type ChainPool, type ChainTransportHooks } from '@dotli/chains';
import { observeChains } from './observe-chains.js';

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
