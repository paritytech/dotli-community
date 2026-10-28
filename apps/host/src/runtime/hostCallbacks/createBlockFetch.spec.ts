// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import type { Backend } from '@dotli/config';
import { createBlockFetch } from './createBlockFetch.js';

describe('preimage block fetch', () => {
  it.each<{ backend: Backend; over: string; calls: { bitswap: number; gateway: number } }>([
    { backend: 'smoldot-direct', over: 'bitswap', calls: { bitswap: 1, gateway: 0 } },
    { backend: 'smoldot-shared-worker', over: 'bitswap', calls: { bitswap: 1, gateway: 0 } },
    { backend: 'rpc-gateway', over: 'gateway', calls: { bitswap: 0, gateway: 1 } },
  ])(
    'As a product developer on $backend, I fetch a preimage block and it comes over $over',
    async ({ backend, calls }) => {
      // Given
      const block = new Uint8Array([1, 2, 3]);
      const fetchOverBitswap = vi.fn((_cid: string, _signal: AbortSignal) => Promise.resolve(block));
      const fetchFromGateway = vi.fn((_cid: string) => Promise.resolve(block));
      const fetchBlock = createBlockFetch({ backend: (): Backend => backend, fetchOverBitswap, fetchFromGateway });

      // When
      const result = await fetchBlock('bafkcid', new AbortController().signal);

      // Then
      expect(result).toEqual({ data: block, source: backend });
      expect({ bitswap: fetchOverBitswap.mock.calls.length, gateway: fetchFromGateway.mock.calls.length }).toEqual(
        calls,
      );
    },
  );

  it('As a dotli integrator, I fetch a block that fails and the error names the backend it went through', async () => {
    // Given
    const cause = new Error('gateway unavailable');
    const fetchBlock = createBlockFetch({
      backend: (): Backend => 'rpc-gateway',
      fetchOverBitswap: () => Promise.resolve(new Uint8Array()),
      fetchFromGateway: () => Promise.reject(cause),
    });

    // When
    const failure = fetchBlock('bafkcid', new AbortController().signal);

    // Then
    await expect(failure).rejects.toThrow('Preimage fetch via rpc-gateway failed');
    await expect(failure).rejects.toMatchObject({ cause });
  });
});
