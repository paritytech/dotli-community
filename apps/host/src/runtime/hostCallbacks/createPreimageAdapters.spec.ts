// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { blake2b } from '@noble/hashes/blake2.js';
import { loadVerify } from '@dotli/content';
import { bindCaptureSink } from '@dotli/metrics';
import { bindRecordingSentry } from '@dotli/metrics/testing';
import type { PreimageBlock, PreimageFetch } from './createBlockFetch.js';
import { createPreimageAdapters } from './createPreimageAdapters.js';
import { yielded } from '../../testing/fixtures.js';

describe('preimage host callbacks', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Registered first, so it runs after every cleanup a test registers.
    onTestFinished(() => {
      vi.useRealTimers();
    });
  });

  it('As an operator, I watch a backend that keeps failing a lookup and it is recorded once, not on every poll', async () => {
    // Given
    const captures = { exception: vi.fn(), expected: vi.fn() };
    onTestFinished(bindCaptureSink(captures));
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const fetchBlock = vi.fn<PreimageFetch>(() => Promise.reject(new Error('gateway unavailable')));
    const { lookupPreimage } = createPreimageAdapters('myapp', { fetchBlock });
    const iterator = lookupPreimage(new Uint8Array(32))[Symbol.asyncIterator]();
    onTestFinished(async () => {
      await iterator.return?.();
    });
    await iterator.next();

    // When the poll fails four times
    await vi.advanceTimersByTimeAsync(1_000 + 3 * 10_000);

    // Then
    expect(fetchBlock).toHaveBeenCalledTimes(4);
    expect(captures.expected.mock.calls).toMatchObject([[expect.any(Error), { step: 'preimage_lookup' }]]);
    expect(metrics.counted('preimage.lookup')).toEqual([{ outcome: 'error', reason: 'fetch' }]);
  });

  it('As an operator, I watch a backend that serves the wrong bytes for a preimage and it is captured and counted', async () => {
    // Given
    const captures = { exception: vi.fn(), expected: vi.fn() };
    onTestFinished(bindCaptureSink(captures));
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const key = blake2b(new TextEncoder().encode('expected preimage'), { dkLen: 32 });
    const fetchBlock = vi.fn<PreimageFetch>(() => Promise.resolve(buildBlock(new TextEncoder().encode('tampered'))));
    const { lookupPreimage } = createPreimageAdapters('myapp', { fetchBlock });
    const iterator = lookupPreimage(key)[Symbol.asyncIterator]();
    onTestFinished(async () => {
      await iterator.return?.();
    });
    await iterator.next();

    // When
    const answer = iterator.next();
    await vi.advanceTimersByTimeAsync(1_000);
    await answer;

    // Then
    expect(captures.exception).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ step: 'preimage_lookup' }),
    );
    expect(metrics.counted('preimage.lookup')).toEqual([{ outcome: 'error', reason: 'mismatch' }]);
  });

  it('As an operator, I watch a verifier chunk fail to load and it is reported once while the next poll verifies the block', async () => {
    // Given
    const captures = { exception: vi.fn(), expected: vi.fn() };
    onTestFinished(bindCaptureSink(captures));
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const data = new TextEncoder().encode('block behind a missing chunk');
    const key = blake2b(data, { dkLen: 32 });
    const fetchBlock = vi.fn<PreimageFetch>(() => Promise.resolve(buildBlock(data)));
    const flakyLoad = vi.fn(loadVerify).mockRejectedValueOnce(new Error('chunk gone'));
    const { lookupPreimage } = createPreimageAdapters('myapp', { fetchBlock, loadVerify: flakyLoad });
    const iterator = lookupPreimage(key)[Symbol.asyncIterator]();
    onTestFinished(async () => {
      await iterator.return?.();
    });
    await iterator.next();
    const answer = iterator.next();

    // When the first poll hits the missing chunk and the next one loads it
    await vi.advanceTimersByTimeAsync(1_000 + 10_000);
    const hit = await answer;

    // Then
    expect(yielded(hit)._unsafeUnwrap()).toEqual(data);
    expect(captures.expected.mock.calls).toMatchObject([[expect.any(Error), { step: 'preimage_verify_load' }]]);
    expect(metrics.counted('lazy_chunk.load')).toEqual([{ outcome: 'error', reason: 'preimage_verify_load' }]);
  });

  it('As a product developer, I look up an uncached preimage and get a miss at once', async () => {
    // Given
    const { lookupPreimage } = createPreimageAdapters('myapp', { fetchBlock: createMissingFetch() });
    const iterator = lookupPreimage(new Uint8Array(32))[Symbol.asyncIterator]();
    onTestFinished(async () => {
      await iterator.return?.();
    });

    // When
    const first = await iterator.next();

    // Then
    expect(yielded(first)._unsafeUnwrap()).toBeUndefined();
  });

  it('As a product developer, I look up a preimage while its backend fails once and the lookup retries it', async () => {
    // Given
    const data = new TextEncoder().encode('retried preimage');
    const key = blake2b(data, { dkLen: 32 });
    const fetchBlock = vi
      .fn<PreimageFetch>()
      .mockRejectedValueOnce(new Error('gateway unavailable'))
      .mockResolvedValueOnce(buildBlock(data));
    const { lookupPreimage } = createPreimageAdapters('myapp', { fetchBlock });
    const iterator = lookupPreimage(key)[Symbol.asyncIterator]();
    onTestFinished(async () => {
      await iterator.return?.();
    });

    // When the first poll fails
    const first = await iterator.next();
    const secondPromise = iterator.next();
    let secondSettled = false;
    void secondPromise.then(() => {
      secondSettled = true;
    });
    await vi.advanceTimersByTimeAsync(1000);

    // Then
    expect(secondSettled).toBe(false);
    expect(fetchBlock).toHaveBeenCalledTimes(1);

    // When the next poll goes through
    await vi.advanceTimersByTimeAsync(10_000);
    const second = await secondPromise;

    // Then
    expect([first, second].map(step => yielded(step)._unsafeUnwrap())).toEqual([undefined, data]);
    expect(fetchBlock).toHaveBeenCalledTimes(2);
  });

  it('As a product developer, I look up a preimage and it is cached only after hash verification', async () => {
    // Given
    const data = new TextEncoder().encode('verified gateway preimage');
    const key = blake2b(data, { dkLen: 32 });
    const fetchBlock = vi.fn<PreimageFetch>(() => Promise.resolve(buildBlock(data)));
    const { lookupPreimage } = createPreimageAdapters('myapp', { fetchBlock });

    // When
    const iterator = lookupPreimage(key)[Symbol.asyncIterator]();
    await iterator.next();
    const foundPromise = iterator.next();
    await vi.advanceTimersByTimeAsync(1000);
    const hit = await foundPromise;
    await iterator.return?.();

    // Then
    expect(yielded(hit)._unsafeUnwrap()).toEqual(data);

    // When
    const cached = await lookupPreimage(key)[Symbol.asyncIterator]().next();

    // Then
    expect(yielded(cached)._unsafeUnwrap()).toBe(data);
    expect(fetchBlock).toHaveBeenCalledTimes(1);
  });

  it('As a product developer, I look up a preimage that comes back corrupt and the host rejects it, stops polling and does not cache it', async () => {
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
    expect(
      [secondMiss, secondError].map(step =>
        yielded(step).match(
          value => ({ value }),
          () => 'error',
        ),
      ),
    ).toStrictEqual([{ value: undefined }, 'error']);
    expect(fetchBlock).toHaveBeenCalledTimes(2);
  });

  it('As a user, I wait on a slow preimage lookup and no other lookup stacks up on every poll tick', async () => {
    // Given a lookup that outlives several poll intervals, as a bitswap fetch can while providers attach
    const { fetchBlock, release } = createHeldFetch();
    const { lookupPreimage } = createPreimageAdapters('myapp', { fetchBlock });
    const iterator = lookupPreimage(new Uint8Array(32).fill(7))[Symbol.asyncIterator]();
    onTestFinished(async () => {
      release(new Uint8Array());
      await iterator.return?.();
    });

    // When four poll intervals pass while the first lookup is still in flight
    await iterator.next();
    await vi.advanceTimersByTimeAsync(45_000);

    // Then only the first attempt issued a request
    expect(fetchBlock).toHaveBeenCalledTimes(1);
  });

  it('As a product developer, I look up one key twice and both lookups share a fetch and receive the preimage', async () => {
    // Given
    const data = new TextEncoder().encode('shared preimage');
    const key = blake2b(data, { dkLen: 32 });
    const { fetchBlock, release } = createHeldFetch();
    const { lookupPreimage } = createPreimageAdapters('myapp', { fetchBlock });
    const first = lookupPreimage(key)[Symbol.asyncIterator]();
    const second = lookupPreimage(key)[Symbol.asyncIterator]();
    onTestFinished(async () => {
      await first.return?.();
      await second.return?.();
    });
    await first.next();
    await second.next();
    const firstHit = first.next();
    const secondHit = second.next();

    // When
    await vi.advanceTimersByTimeAsync(1000);
    release(data);
    const hits = await Promise.all([firstHit, secondHit]);

    // Then
    expect(hits.map(hit => yielded(hit)._unsafeUnwrap())).toEqual([data, data]);
    expect(fetchBlock).toHaveBeenCalledTimes(1);
  });

  it('As a user, I drop a preimage subscription mid-lookup and the lookup it left running is cancelled', async () => {
    // Given a lookup that is still retrying when the product lets go
    let handed: AbortSignal | undefined;
    const fetchBlock = vi.fn<PreimageFetch>((_cid, signal) => {
      handed = signal;
      return new Promise<PreimageBlock>(() => undefined);
    });
    const { lookupPreimage } = createPreimageAdapters('myapp', { fetchBlock });
    const iterator = lookupPreimage(new Uint8Array(32).fill(9))[Symbol.asyncIterator]();
    await iterator.next();
    await vi.advanceTimersByTimeAsync(1500);
    const abortedBefore = handed?.aborted;

    // When the subscription is torn down mid-lookup
    await iterator.return?.();

    // Then the host stops fetching for a consumer that has gone
    expect([abortedBefore, handed?.aborted]).toEqual([false, true]);
  });

  it('As a user, I drop a subscription before its first attempt and nothing is fetched', async () => {
    // Given
    const fetchBlock = createMissingFetch();
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

/** A fetch whose every block comes back empty, so each lookup misses. */
function createMissingFetch(): ReturnType<typeof vi.fn<PreimageFetch>> {
  return vi.fn<PreimageFetch>(() => Promise.resolve({ data: new Uint8Array(), source: 'smoldot-direct' }));
}

function buildBlock(data: Uint8Array): PreimageBlock {
  return { data, source: 'smoldot-direct' };
}

/** A fetch that stays in flight until the test releases it. */
function createHeldFetch() {
  let resolveFetch: (data: Uint8Array) => void = () => undefined;
  const fetchBlock = vi.fn<PreimageFetch>(
    () =>
      new Promise<PreimageBlock>(resolve => {
        resolveFetch = data => {
          resolve(buildBlock(data));
        };
      }),
  );

  function release(data: Uint8Array): void {
    resolveFetch(data);
  }

  return {
    /** The fetch, recording each call. */
    fetchBlock,
    /** Answers the fetch in flight with `data`. */
    release,
  };
}
