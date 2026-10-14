// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { blake2b } from '@noble/hashes/blake2.js';
import type { Backend } from '@dotli/config';
import { createBlockFetch, createPreimageAdapters, type PreimageBlock, type PreimageFetch } from './preimage.js';
import { yielded } from '../../testing/fixtures.js';

/** A fetch that misses until a test answers it. */
function missingBlock(): ReturnType<typeof vi.fn<PreimageFetch>> {
  return vi.fn<PreimageFetch>(() => Promise.resolve({ data: new Uint8Array(), source: 'smoldot-direct' }));
}

function found(data: Uint8Array): PreimageBlock {
  return { data, source: 'smoldot-direct' };
}

/** A fetch that stays in flight until the test releases it. */
function heldBlock(): { fetchBlock: ReturnType<typeof vi.fn<PreimageFetch>>; release: (data: Uint8Array) => void } {
  let release: (data: Uint8Array) => void = () => undefined;
  const fetchBlock = vi.fn<PreimageFetch>(
    () =>
      new Promise<PreimageBlock>(resolve => {
        release = data => {
          resolve(found(data));
        };
      }),
  );
  return {
    fetchBlock,
    release: data => {
      release(data);
    },
  };
}

describe('preimage host callbacks', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('As a dotli integrator, the host emits a miss immediately for an uncached lookup', async () => {
    // Given
    const { lookupPreimage } = createPreimageAdapters('myapp', { fetchBlock: missingBlock() });
    const missingKey = new Uint8Array(32);

    // When
    const iterator = lookupPreimage(missingKey)[Symbol.asyncIterator]();
    const first = await iterator.next();
    await iterator.return?.();

    // Then
    expect(first.done).toBe(false);
    expect(yielded(first).isOk()).toBe(true);
    expect(yielded(first)._unsafeUnwrap()).toBeUndefined();
  });

  it('As a dotli integrator, I get only the lookup callback because submission is core-owned', () => {
    // When
    const adapters = createPreimageAdapters('myapp', { fetchBlock: missingBlock() });

    // Then
    expect(typeof adapters.lookupPreimage).toBe('function');
    expect('submitPreimage' in adapters).toBe(false);
  });

  it('As a dotli integrator, the host retries transient lookup backend failures', async () => {
    // Given
    const data = new TextEncoder().encode('retried preimage');
    const key = blake2b(data, { dkLen: 32 });
    const fetchBlock = vi
      .fn<PreimageFetch>()
      .mockRejectedValueOnce(new Error('gateway unavailable'))
      .mockResolvedValueOnce(found(data));
    const { lookupPreimage } = createPreimageAdapters('myapp', { fetchBlock });

    // When
    const iterator = lookupPreimage(key)[Symbol.asyncIterator]();
    const first = await iterator.next();
    const secondPromise = iterator.next();
    let secondSettled = false;
    void secondPromise.then(() => {
      secondSettled = true;
    });
    await vi.advanceTimersByTimeAsync(1000);

    // Then
    expect(yielded(first)._unsafeUnwrap()).toBeUndefined();
    expect(secondSettled).toBe(false);
    expect(fetchBlock).toHaveBeenCalledTimes(1);

    // When
    await vi.advanceTimersByTimeAsync(10_000);

    // Then
    const second = await secondPromise;
    expect(second.done).toBe(false);
    expect(yielded(second)._unsafeUnwrap()).toEqual(data);
    expect(fetchBlock).toHaveBeenCalledTimes(2);
    await iterator.return?.();
  });

  it('As a dotli integrator, the host caches a preimage only after hash verification', async () => {
    // Given
    const data = new TextEncoder().encode('verified gateway preimage');
    const key = blake2b(data, { dkLen: 32 });
    const fetchBlock = vi.fn<PreimageFetch>(() => Promise.resolve(found(data)));
    const { lookupPreimage } = createPreimageAdapters('myapp', { fetchBlock });

    // When
    const iterator = lookupPreimage(key)[Symbol.asyncIterator]();
    await iterator.next();
    const foundPromise = iterator.next();
    await vi.advanceTimersByTimeAsync(1000);
    const hit = await foundPromise;
    await iterator.return?.();

    // Then
    expect(yielded(hit).isOk()).toBe(true);
    expect(yielded(hit)._unsafeUnwrap()).toEqual(data);

    // When
    const cached = await lookupPreimage(key)[Symbol.asyncIterator]().next();

    // Then
    expect(yielded(cached)._unsafeUnwrap()).toEqual(data);
    expect(fetchBlock).toHaveBeenCalledTimes(1);
  });

  it('As a product, the host rejects corrupt data, stops polling and does not cache it', async () => {
    // Given
    const expected = new TextEncoder().encode('expected preimage');
    const key = blake2b(expected, { dkLen: 32 });
    const fetchBlock = vi.fn<PreimageFetch>(() =>
      Promise.resolve({ data: new TextEncoder().encode('corrupt preimage'), source: 'rpc-gateway' }),
    );
    const { lookupPreimage } = createPreimageAdapters('myapp', { fetchBlock });

    // When
    const firstIterator = lookupPreimage(key)[Symbol.asyncIterator]();
    await firstIterator.next();
    const firstErrorPromise = firstIterator.next();
    await vi.advanceTimersByTimeAsync(1000);
    const firstError = await firstErrorPromise;
    await vi.advanceTimersByTimeAsync(30_000);

    // Then
    expect(yielded(firstError).isErr()).toBe(true);
    expect(yielded(firstError)._unsafeUnwrapErr().reason).toContain('preimage lookup via rpc-gateway failed');
    expect(yielded(firstError)._unsafeUnwrapErr().reason).toContain('Content hash mismatch');
    expect(fetchBlock).toHaveBeenCalledTimes(1);

    // When
    const secondIterator = lookupPreimage(key)[Symbol.asyncIterator]();
    const secondMiss = await secondIterator.next();
    const secondErrorPromise = secondIterator.next();
    await vi.advanceTimersByTimeAsync(1000);
    const secondError = await secondErrorPromise;

    // Then
    expect(yielded(secondMiss)._unsafeUnwrap()).toBeUndefined();
    expect(yielded(secondError).isErr()).toBe(true);
    expect(fetchBlock).toHaveBeenCalledTimes(2);
  });

  it('As a user, a slow preimage lookup does not stack another on every poll tick', async () => {
    // Given a lookup that outlives several poll intervals, as a bitswap fetch can while providers attach
    const { fetchBlock, release } = heldBlock();
    const { lookupPreimage } = createPreimageAdapters('myapp', { fetchBlock });
    const key = new Uint8Array(32).fill(7);

    // When four poll intervals pass while the first lookup is still in flight
    const iterator = lookupPreimage(key)[Symbol.asyncIterator]();
    await iterator.next();
    await vi.advanceTimersByTimeAsync(45_000);

    // Then only the first attempt issued a request
    expect(fetchBlock).toHaveBeenCalledTimes(1);

    release(new Uint8Array());
    await iterator.return?.();
  });

  it('As a product, two lookups of one key share a fetch and both receive the preimage', async () => {
    // Given
    const data = new TextEncoder().encode('shared preimage');
    const key = blake2b(data, { dkLen: 32 });
    const { fetchBlock, release } = heldBlock();
    const { lookupPreimage } = createPreimageAdapters('myapp', { fetchBlock });
    const first = lookupPreimage(key)[Symbol.asyncIterator]();
    const second = lookupPreimage(key)[Symbol.asyncIterator]();
    await first.next();
    await second.next();
    const firstHit = first.next();
    const secondHit = second.next();

    // When
    await vi.advanceTimersByTimeAsync(1000);
    release(data);

    // Then
    expect(yielded(await firstHit)._unsafeUnwrap()).toEqual(data);
    expect(yielded(await secondHit)._unsafeUnwrap()).toEqual(data);
    expect(fetchBlock).toHaveBeenCalledTimes(1);
    await first.return?.();
    await second.return?.();
  });

  it('As a user, dropping a preimage subscription cancels the lookup it left running', async () => {
    // Given a lookup that is still retrying when the product lets go
    let handed: AbortSignal | undefined;
    const fetchBlock = vi.fn<PreimageFetch>((_cid, signal) => {
      handed = signal;
      return new Promise<PreimageBlock>(() => undefined);
    });
    const { lookupPreimage } = createPreimageAdapters('myapp', { fetchBlock });
    const key = new Uint8Array(32).fill(9);

    // When the subscription is torn down mid-lookup
    const iterator = lookupPreimage(key)[Symbol.asyncIterator]();
    await iterator.next();
    await vi.advanceTimersByTimeAsync(1500);
    expect(handed?.aborted).toBe(false);
    await iterator.return?.();

    // Then the host stops fetching for a consumer that has gone
    expect(handed?.aborted).toBe(true);
  });

  it('As a user, a dropped subscription that never reached its first attempt fetches nothing', async () => {
    // Given
    const fetchBlock = missingBlock();
    const { lookupPreimage } = createPreimageAdapters('myapp', { fetchBlock });
    const iterator = lookupPreimage(new Uint8Array(32).fill(3))[Symbol.asyncIterator]();
    await iterator.next();

    // When
    await iterator.return?.();
    await vi.advanceTimersByTimeAsync(30_000);

    // Then
    expect(fetchBlock).not.toHaveBeenCalled();
  });
});

describe('preimage block fetch', () => {
  it.each([
    ['smoldot-direct', 'bitswap'],
    ['smoldot-shared-worker', 'bitswap'],
    ['rpc-gateway', 'gateway'],
  ] as const)('As a product on %s, the host fetches a preimage block over %s', async (backend, expected) => {
    // Given
    const block = new Uint8Array([1, 2, 3]);
    const bitswap = vi.fn((_cid: string, _signal: AbortSignal) => Promise.resolve(block));
    const gateway = vi.fn((_cid: string) => Promise.resolve(block));
    const fetchBlock = createBlockFetch({ backend: (): Backend => backend, bitswap, gateway });

    // When
    const result = await fetchBlock('bafkcid', new AbortController().signal);

    // Then
    expect(result).toEqual({ data: block, source: backend });
    expect(bitswap).toHaveBeenCalledTimes(expected === 'bitswap' ? 1 : 0);
    expect(gateway).toHaveBeenCalledTimes(expected === 'gateway' ? 1 : 0);
  });

  it('As a dotli integrator, a failed block fetch names the backend it went through', async () => {
    // Given
    const cause = new Error('gateway unavailable');
    const fetchBlock = createBlockFetch({
      backend: (): Backend => 'rpc-gateway',
      bitswap: () => Promise.resolve(new Uint8Array()),
      gateway: () => Promise.reject(cause),
    });

    // When
    const failure = fetchBlock('bafkcid', new AbortController().signal);

    // Then
    await expect(failure).rejects.toThrow('Preimage fetch via rpc-gateway failed');
    await expect(failure).rejects.toMatchObject({ cause });
  });
});
