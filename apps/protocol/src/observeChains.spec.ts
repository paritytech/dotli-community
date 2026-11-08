// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi, type Mock } from 'vitest';
import { catchError, createManualTimers } from '@dotli/shared/testing';
import type { JsonRpcConnection, JsonRpcProvider } from '@polkadot-api/json-rpc-provider';
import { createChainPool, type ChainTransport, type ChainTransportHooks } from '@dotli/chains';
import { realTimers, type Timers } from '@dotli/shared';
import { observeChains } from './observeChains.js';

type Built = {
  genesisHash: string;
  disconnect: Mock<() => void>;
  /** The transport halts for good. */
  halt: (error: unknown) => void;
};

type CreatePoolParams = {
  /** Chains the pool has no transport for. */
  unsupported?: readonly string[];
  /** The timers the pool's redial waits run on. */
  timers?: Timers;
};

function createPool(destroyDelay: number, { unsupported = [], timers = realTimers }: CreatePoolParams = {}) {
  const built: Built[] = [];
  return {
    /** The pool whose chains are watched. */
    pool: createChainPool({ createTransport, destroyDelay, timers }),
    /** Each chain transport the pool built, in order. */
    built,
  };

  function createTransport(genesisHash: string, hooks: ChainTransportHooks): ChainTransport | null {
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
    const provider: JsonRpcProvider = (): JsonRpcConnection => ({
      send() {
        /* requests are not under test */
      },
      disconnect: record.disconnect,
    });
    return { provider, followLimit: Infinity };
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
    const { pool, built } = createPool(0, { unsupported: ['0xaa'] });

    // When the chains are watched, and the watch is stopped
    const stop = observeChains({ pool, genesisHashes: ['0xaa', '0xbb'] });
    const opened = built.map(b => b.genesisHash);
    const thrown = catchError(stop);

    // Then
    expect(opened).toEqual(['0xbb']);
    expect(thrown).toBeUndefined();
    expect(built.map(b => b.disconnect.mock.calls.length)).toEqual([1]);
  });

  it('As the sync observer, my chain halts and the pool gives it back under my lease', () => {
    // Given
    const { pool, built } = createPool(0);
    observeChains({ pool, genesisHashes: ['0xaa', '0xbb'] });

    // When
    built[0]?.halt(new Error('gone'));

    // Then
    expect(built.map(b => b.genesisHash)).toEqual(['0xaa', '0xbb', '0xaa']);
    expect(built[2]?.disconnect).not.toHaveBeenCalled();
  });

  it('As a dotli integrator, I stop the watch while a halted chain waits on its gate and it is not reopened', async () => {
    // Given a chain that halts again right after its first heal, so its second heal waits on the gate
    const timers = createManualTimers();
    const { pool, built } = createPool(0, { timers });
    const stop = observeChains({ pool, genesisHashes: ['0xaa'] });
    built[0]?.halt(new Error('gone'));
    built[1]?.halt(new Error('gone again'));

    // When
    stop();
    await timers.advance(30_000);

    // Then
    expect(built.map(b => b.genesisHash)).toEqual(['0xaa', '0xaa']);
  });
});
