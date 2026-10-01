// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { JsonRpcConnection, JsonRpcProvider } from '@polkadot-api/json-rpc-provider';
import { createChainPool, type ChainPool } from '@dotli/protocol';
import type { ChainTransportHooks } from '@dotli/resolver';
import { log } from '@dotli/shared';
import { observeChains } from '../src/observe-chains.js';

interface Built {
  genesisHash: string;
  disconnect: Mock<() => void>;
}

function setup(destroyDelay: number, unsupported: readonly string[] = []): { pool: ChainPool; built: Built[] } {
  const built: Built[] = [];
  const createTransport = (genesisHash: string, _hooks: ChainTransportHooks): JsonRpcProvider | null => {
    if (unsupported.includes(genesisHash)) {
      return null;
    }
    const record: Built = { genesisHash, disconnect: vi.fn<() => void>() };
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
  beforeEach(() => {
    vi.spyOn(log, 'debug').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('As a dotli user on a light client, the chains the loading bar watches are opened once and kept', () => {
    // Given
    const { pool, built } = setup(Infinity);

    // When
    observeChains(pool, ['0xaa', '0xbb']);
    pool.connectRemote('0xbb', 'c1', () => undefined);

    // Then
    expect(built.map(b => b.genesisHash)).toEqual(['0xaa', '0xbb']);
  });

  it('As a dotli integrator, stopping the watch releases its leases', () => {
    // Given
    const { pool, built } = setup(0);
    const stop = observeChains(pool, ['0xaa', '0xbb']);

    // When
    stop();
    stop();

    // Then
    expect(built.map(b => b.disconnect.mock.calls.length)).toEqual([1, 1]);
  });

  it('As a dotli user on a network without a chain, the watch skips it', () => {
    // Given
    const { pool, built } = setup(Infinity, ['0xaa']);

    // When
    const stop = observeChains(pool, ['0xaa', '0xbb']);

    // Then
    expect(built.map(b => b.genesisHash)).toEqual(['0xbb']);
    stop();
  });
});
