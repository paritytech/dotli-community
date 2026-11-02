// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi, type Mock } from 'vitest';
import { catchError, createManualTimers } from '@dotli/shared/testing';
import type { JsonRpcConnection, JsonRpcProvider } from '@polkadot-api/json-rpc-provider';
import { createChainPool, type ChainTransportHooks } from '@dotli/chains';
import { observeChains } from './observeChains.js';

type Built = {
  genesisHash: string;
  disconnect: Mock<() => void>;
  /** The transport halts for good. */
  halt: (error: unknown) => void;
};

function createPool(destroyDelay: number, unsupported: readonly string[] = []) {
  const built: Built[] = [];
  return {
    /** The pool whose chains are watched. */
    pool: createChainPool({ createTransport, destroyDelay }),
    /** Each chain transport the pool built, in order. */
    built,
  };

  function createTransport(genesisHash: string, hooks: ChainTransportHooks): JsonRpcProvider | null {
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
  }
}

describe('observeChains', () => {
  it('As a dotli user on a light client, I watch chains a dApp then leaves and they stay open, each opened once', () => {
    // Given
    const { pool, built } = createPool(0);

    // When a dApp connects to a watched chain and leaves
    observeChains({ pool, genesisHashes: ['0xaa', '0xbb'] });
    pool.connectRemote({ genesisHash: '0xbb', connectionId: 'c1', onMessage: () => undefined })?.disconnect();

    // Then
    expect(built.map(b => b.genesisHash)).toEqual(['0xaa', '0xbb']);
    expect(built.map(b => b.disconnect.mock.calls.length)).toEqual([0, 0]);
  });

  it('As a dotli integrator, I stop the watch and its leases are released', () => {
    // Given
    const { pool, built } = createPool(0);
    const stop = observeChains({ pool, genesisHashes: ['0xaa', '0xbb'] });

    // When
    stop();
    stop();

    // Then
    expect(built.map(b => b.disconnect.mock.calls.length)).toEqual([1, 1]);
  });

  it('As a dotli user on a network without a chain, I watch the chains and the watch skips the missing one', () => {
    // Given
    const { pool, built } = createPool(0, ['0xaa']);

    // When the chains are watched, and the watch is stopped
    const stop = observeChains({ pool, genesisHashes: ['0xaa', '0xbb'] });
    const opened = built.map(b => b.genesisHash);
    const thrown = catchError(stop);

    // Then
    expect(opened).toEqual(['0xbb']);
    expect(thrown).toBeUndefined();
    expect(built.map(b => b.disconnect.mock.calls.length)).toEqual([1]);
  });

  it('As a dotli user on a light client, I watch a chain whose transport halted and keep seeing its sync on the chain the pool rebuilds', () => {
    // Given
    const { pool, built } = createPool(0);
    observeChains({ pool, genesisHashes: ['0xaa', '0xbb'], retakeDelayMs: 0 });

    // When
    built[0]?.halt(new Error('gone'));

    // Then
    expect(built.map(b => b.genesisHash)).toEqual(['0xaa', '0xbb', '0xaa']);
    expect(built[2]?.disconnect).not.toHaveBeenCalled();
  });

  it('As a dotli user on a light client, I watch a chain halt again after it was rebuilt and keep seeing its sync', async () => {
    // Given
    const timers = createManualTimers();
    const { pool, built } = createPool(0);
    observeChains({ pool, genesisHashes: ['0xaa'], retakeDelayMs: 1_000, timers });
    built[0]?.halt(new Error('gone'));
    await timers.advance(1_000);

    // When
    built[1]?.halt(new Error('gone again'));
    await timers.advance(1_000);

    // Then
    expect(built.map(b => b.genesisHash)).toEqual(['0xaa', '0xaa', '0xaa']);
  });

  it('As a dotli integrator, I watch a chain report its halt twice and see one new lease', async () => {
    // Given
    const timers = createManualTimers();
    const { pool, built } = createPool(0);
    observeChains({ pool, genesisHashes: ['0xaa'], retakeDelayMs: 1_000, timers });

    // When
    built[0]?.halt(new Error('gone'));
    built[0]?.halt(new Error('gone'));
    await timers.advance(1_000);

    // Then
    expect(built.map(b => b.genesisHash)).toEqual(['0xaa', '0xaa']);
  });

  it('As a dotli integrator, I watch a chain halt and see it taken again only once the re-take delay has passed', async () => {
    // Given
    const timers = createManualTimers();
    const { pool, built } = createPool(0);
    observeChains({ pool, genesisHashes: ['0xaa'], retakeDelayMs: 1_000, timers });

    // When
    built[0]?.halt(new Error('gone'));
    const beforeDelay = built.length;
    await timers.advance(1_000);

    // Then
    expect(beforeDelay).toBe(1);
    expect(built.map(b => b.genesisHash)).toEqual(['0xaa', '0xaa']);
  });

  it('As a dotli integrator, I stop the watch while a halted chain waits to be taken again and it is not reopened', async () => {
    // Given
    const timers = createManualTimers();
    const { pool, built } = createPool(0);
    const stop = observeChains({ pool, genesisHashes: ['0xaa'], retakeDelayMs: 1_000, timers });
    built[0]?.halt(new Error('gone'));

    // When
    stop();
    await timers.advance(1_000);

    // Then
    expect(built.map(b => b.genesisHash)).toEqual(['0xaa']);
  });
});
