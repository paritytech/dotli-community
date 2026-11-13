// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { createDeferred } from '@dotli/shared';
import { createManualTimers } from '@dotli/shared/testing';
import { type BlockCache, createBlockCache } from './blockCache.js';
import { abortAtCommit } from './testing/abortAtCommit.js';
import { createMemoryIdb, type MemoryIdb } from './testing/index.js';
import { bindCaptureSink } from '@dotli/metrics';
import { bindRecordingSentry } from '@dotli/metrics/testing';

// Each test gets a fresh database, so no test sees another's records.
let idb: MemoryIdb;
let cache: BlockCache;

beforeEach(() => {
  idb = createMemoryIdb();
  cache = createBlockCache({ idb });
});

/** A write of the bookkeeping alone, which is what a batch of touches is. */
function isTouchWrite(transaction: IDBTransaction): boolean {
  return transaction.mode === 'readwrite' && Array.from(transaction.objectStoreNames).join() === 'block_meta';
}

describe('block cache', () => {
  it('As a user, I load a block the host fetched before and it comes back', async () => {
    // Given
    await cache.put('bafyA', new Uint8Array([1, 2, 3]));

    // When
    const bytes = await cache.get('bafyA');

    // Then
    expect(bytes).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('As a user, I read a block the host never fetched and get a miss rather than an error', async () => {
    // When
    const bytes = await cache.get('bafyNever');

    // Then
    expect(bytes).toBeNull();
  });

  it('As a user, I delete a block the relay found corrupted and it is gone', async () => {
    // Given
    await cache.put('bafyBad', new Uint8Array([9]));

    // When
    await cache.remove('bafyBad');

    // Then
    expect(await cache.get('bafyBad')).toBeNull();
  });

  it('As a user whose cache outgrew its limit, I prune it and the blocks I used longest ago go first', async () => {
    // Given three 3-byte blocks stored in order, and the oldest read again last
    const clock = createManualTimers({ start: 1_000 });
    const timed = createBlockCache({ idb, timers: clock });
    await timed.put('bafyOld', new Uint8Array(3));
    await clock.advance(1_000);
    await timed.put('bafyStale', new Uint8Array(3));
    await clock.advance(1_000);
    await timed.put('bafyRecent', new Uint8Array(3));
    await clock.advance(1_000);
    await timed.get('bafyOld');

    // When the cache is pruned to room for two of them
    const evicted = await timed.prune(6);

    // Then only the one nobody used since it was stored is dropped
    expect(evicted).toBe(1);
    expect(await timed.get('bafyStale')).toBeNull();
    expect(await timed.get('bafyOld')).not.toBeNull();
    expect(await timed.get('bafyRecent')).not.toBeNull();
  });

  it('As a user, I turn the archive cache off and nothing the host kept survives', async () => {
    // Given
    await cache.put('bafyA', new Uint8Array([1]));
    await cache.put('bafyB', new Uint8Array([2]));

    // When
    const cleared = await cache.clear();

    // Then
    expect(cleared).toBe(true);
    expect(await cache.get('bafyA')).toBeNull();
    expect(await cache.get('bafyB')).toBeNull();
  });

  it('As a user opening a cached product, I read a block and am answered while another read of the cache is still running', async () => {
    // Given a cached block, and a long read of the block store already running
    await cache.put('bafyA', new Uint8Array([1]));
    const db = await idb.connect();
    const events: string[] = [];
    const longRead = new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('blocks', 'readonly');
      const store = transaction.objectStore('blocks');
      let left = 100;
      function readAgain(): void {
        const request = store.get('bafyA');
        request.onsuccess = () => {
          left -= 1;
          if (left > 0) {
            readAgain();
          }
        };
      }
      readAgain();
      transaction.oncomplete = () => {
        events.push('long read done');
        resolve();
      };
      transaction.onerror = () => {
        reject(transaction.error ?? new Error('long read failed'));
      };
    });

    // When
    const bytes = await cache.get('bafyA');
    events.push('block read');
    await longRead;

    // Then the block read did not wait for the long one
    expect(bytes).toEqual(new Uint8Array([1]));
    expect(events).toEqual(['block read', 'long read done']);
  });

  it('As a user opening a cached product, I read ten blocks at once and they are marked used in fewer writes than reads', async () => {
    // Given ten cached blocks, and a count of the writes that mark blocks used
    let touchWrites = 0;
    const counted = createBlockCache({
      idb: createMemoryIdb({
        onTransaction: transaction => {
          if (isTouchWrite(transaction)) {
            touchWrites += 1;
          }
        },
      }),
    });
    const cids = Array.from({ length: 10 }, (_, index) => `bafy${String(index)}`);
    for (const cid of cids) {
      await counted.put(cid, new Uint8Array([1]));
    }

    // When the product reads them all at once, and the visit ends with a prune that keeps everything
    await Promise.all(cids.map(cid => counted.get(cid)));
    await counted.prune(Number.MAX_SAFE_INTEGER);

    // Then
    expect(touchWrites).toBeGreaterThan(0);
    expect(touchWrites).toBeLessThan(cids.length);
  });

  it('As a user, I read a block and it stays marked used on my next visit, even when this visit never pruned', async () => {
    // Given three 3-byte blocks stored in order, and a signal for the write that marks a block used
    const touched = createDeferred<undefined>();
    const watched = createMemoryIdb({
      onTransaction: transaction => {
        if (isTouchWrite(transaction)) {
          transaction.addEventListener('complete', () => {
            touched.resolve(undefined);
          });
        }
      },
    });
    const clock = createManualTimers({ start: 1_000 });
    const visit = createBlockCache({ idb: watched, timers: clock });
    await visit.put('bafyOld', new Uint8Array(3));
    await clock.advance(1_000);
    await visit.put('bafyStale', new Uint8Array(3));
    await clock.advance(1_000);
    await visit.put('bafyRecent', new Uint8Array(3));

    // When I read the oldest again, that mark is written, and the next visit prunes
    await clock.advance(1_000);
    await visit.get('bafyOld');
    await touched.promise;
    const nextVisit = createBlockCache({ idb: watched, timers: clock });
    const evicted = await nextVisit.prune(6);

    // Then the prune drops only the block nobody used since it was stored
    expect(evicted).toBe(1);
    expect(await nextVisit.get('bafyStale')).toBeNull();
    expect(await nextVisit.get('bafyOld')).not.toBeNull();
  });

  it('As a user, I keep my blocks when the relay deletes one right after reading it, as it leaves nothing that crowds them out', async () => {
    // Given two 3-byte blocks, the older one fetched twice at once
    const clock = createManualTimers({ start: 1_000 });
    const timed = createBlockCache({ idb, timers: clock });
    await timed.put('bafyBad', new Uint8Array(3));
    await clock.advance(1_000);
    await timed.put('bafyGood', new Uint8Array(3));
    await clock.advance(1_000);
    const fetches = [timed.get('bafyBad'), timed.get('bafyBad')];

    // When the relay deletes it as corrupt once the first fetch returns, and the cache is pruned to room for one block
    // The first fetch's mark is still being written then, so the other fetch's mark goes out after the delete.
    await Promise.race(fetches);
    await timed.remove('bafyBad');
    await Promise.all(fetches);
    const evicted = await timed.prune(3);

    // Then the block I keep stays
    expect(evicted).toBe(0);
    expect(await timed.get('bafyGood')).toEqual(new Uint8Array(3));
  });
});

describe('block cache touch failures', () => {
  it('As an operator, I count a touch the browser refuses at commit, and the block is still served', async () => {
    // Given a block cached a while ago, and a database that refuses every write that marks a block used
    const sentry = bindRecordingSentry({ onFinished: onTestFinished });
    const clock = createManualTimers({ start: 1_000 });
    const refusing = createBlockCache({
      idb: createMemoryIdb({
        onTransaction: transaction => {
          if (isTouchWrite(transaction)) {
            abortAtCommit(transaction);
          }
        },
      }),
      timers: clock,
    });
    await refusing.put('bafyA', new Uint8Array([1, 2, 3]));
    await clock.advance(1_000);

    // When I read it, and a prune that keeps everything drains the bookkeeping
    const bytes = await refusing.get('bafyA');
    await refusing.prune(Number.MAX_SAFE_INTEGER);

    // Then the refused mark is counted, and the read still had the bytes
    expect(sentry.counted('cache.storage')).toContainEqual(
      expect.objectContaining({ outcome: 'error', surface: 'block_cache', step: 'touch' }),
    );
    expect(bytes).toEqual(new Uint8Array([1, 2, 3]));
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
    const cleared = await cache.clear();

    // Then the clear says it failed, after a breadcrumb rather than an issue
    expect(cleared).toBe(false);
    expect(captures.exception).not.toHaveBeenCalled();
    expect(captures.expected).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'InvalidStateError' }),
      expect.objectContaining({
        step: 'block_cache_clear',
      }),
    );
  });
});
