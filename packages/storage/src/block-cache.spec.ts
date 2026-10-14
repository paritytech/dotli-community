// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type BlockCache, createBlockCache } from './block-cache.js';
import { memoryIdb, type MemoryIdb } from './testing/index.js';
import { bindCaptureSink } from '@dotli/metrics';

// Each test gets a fresh database, so no test sees another's records.
let idb: MemoryIdb;
let cache: BlockCache;

beforeEach(() => {
  idb = memoryIdb();
  cache = createBlockCache(idb);
});

describe('block cache', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('As a user, a block the host fetched before comes back on the next load', async () => {
    // Given
    await cache.putCachedBlock('bafyA', new Uint8Array([1, 2, 3]));

    // When
    const bytes = await cache.getCachedBlock('bafyA');

    // Then
    expect(bytes).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('As a user, a block the host never fetched is a miss rather than an error', async () => {
    // When
    const bytes = await cache.getCachedBlock('bafyNever');

    // Then
    expect(bytes).toBeNull();
  });

  it('As a user, a block the relay found corrupted is gone once deleted', async () => {
    // Given
    await cache.putCachedBlock('bafyBad', new Uint8Array([9]));

    // When
    await cache.deleteCachedBlock('bafyBad');

    // Then
    expect(await cache.getCachedBlock('bafyBad')).toBeNull();
  });

  it('As a user whose cache outgrew its limit, the blocks I used longest ago go first', async () => {
    // Given three 3-byte blocks stored in order, and the oldest read again last
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000);
    await cache.putCachedBlock('bafyOld', new Uint8Array(3));
    vi.setSystemTime(2_000);
    await cache.putCachedBlock('bafyStale', new Uint8Array(3));
    vi.setSystemTime(3_000);
    await cache.putCachedBlock('bafyRecent', new Uint8Array(3));
    vi.setSystemTime(4_000);
    await cache.getCachedBlock('bafyOld');

    // When the cache is pruned to room for two of them
    const evicted = await cache.pruneBlockCache(6);

    // Then only the one nobody used since it was stored is dropped
    expect(evicted).toBe(1);
    expect(await cache.getCachedBlock('bafyStale')).toBeNull();
    expect(await cache.getCachedBlock('bafyOld')).not.toBeNull();
    expect(await cache.getCachedBlock('bafyRecent')).not.toBeNull();
  });

  it('As a user who turns the archive cache off, nothing the host kept survives', async () => {
    // Given
    await cache.putCachedBlock('bafyA', new Uint8Array([1]));
    await cache.putCachedBlock('bafyB', new Uint8Array([2]));

    // When
    const cleared = await cache.clearBlockCache();

    // Then
    expect(cleared).toBe(true);
    expect(await cache.getCachedBlock('bafyA')).toBeNull();
    expect(await cache.getCachedBlock('bafyB')).toBeNull();
  });

  it('As a user, a malformed cache entry is a miss rather than a hang', async () => {
    // Given a `blocks` record whose `bytes` field isn't a `Uint8Array`, with
    // a matching `block_meta` row so the entry otherwise looks valid — the
    // shape a corrupted write or a future schema change could leave behind
    const db = await idb.connect();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['blocks', 'block_meta'], 'readwrite');
      tx.objectStore('blocks').put({
        cid: 'bafyMalformed',
        bytes: 'not-bytes',
      });
      tx.objectStore('block_meta').put({
        cid: 'bafyMalformed',
        size: 9,
        lastUsed: Date.now(),
      });
      tx.oncomplete = () => {
        resolve();
      };
      tx.onerror = () => {
        reject(tx.error ?? new Error('setup transaction failed'));
      };
    });

    // When
    const bytes = await cache.getCachedBlock('bafyMalformed');

    // Then
    expect(bytes).toBeNull();
  });
});

describe('block cache failure reporting', () => {
  const captures = { exception: vi.fn(), expected: vi.fn() };

  beforeEach(async () => {
    captures.exception.mockClear();
    captures.expected.mockClear();
    await idb.connect();
    return bindCaptureSink(captures);
  });

  it('As a caller that reloads after a clear, I am told when the block cache clear failed on a closing connection, which leaves a breadcrumb and no issue', async () => {
    // Given the cached connection has closed, as it does under an unloading page
    (await idb.connect()).close();

    // When
    const cleared = await cache.clearBlockCache();

    // Then the clear says it failed, after a breadcrumb rather than an issue
    expect(cleared).toBe(false);
    expect(captures.exception).not.toHaveBeenCalled();
    expect(captures.expected).toHaveBeenCalledWith(expect.objectContaining({ name: 'InvalidStateError' }), {
      flow: 'storage',
      step: 'block_cache_clear',
    });
  });
});
