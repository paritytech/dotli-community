// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { deferred } from '@dotli/shared';
import { manualTimers } from '@dotli/shared/testing';
import { type BlockCache, createBlockCache } from './block-cache.js';
import { abortAtCommit } from './testing/abort-at-commit.js';
import { memoryIdb, type MemoryIdb } from './testing/index.js';
import { bindCaptureSink, spans as S } from '@dotli/metrics';
import { bindRecordingSentry } from '@dotli/metrics/testing';

// Each test gets a fresh database, so no test sees another's records.
let idb: MemoryIdb;
let cache: BlockCache;

beforeEach(() => {
  idb = memoryIdb();
  cache = createBlockCache(idb);
});

/** A write of the bookkeeping alone, which is what a batch of touches is. */
function isTouchWrite(tx: IDBTransaction): boolean {
  return tx.mode === 'readwrite' && Array.from(tx.objectStoreNames).join() === 'block_meta';
}

describe('block cache', () => {
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
    const clock = manualTimers(1_000);
    const timed = createBlockCache(idb, clock);
    await timed.putCachedBlock('bafyOld', new Uint8Array(3));
    await clock.advance(1_000);
    await timed.putCachedBlock('bafyStale', new Uint8Array(3));
    await clock.advance(1_000);
    await timed.putCachedBlock('bafyRecent', new Uint8Array(3));
    await clock.advance(1_000);
    await timed.getCachedBlock('bafyOld');

    // When the cache is pruned to room for two of them
    const evicted = await timed.pruneBlockCache(6);

    // Then only the one nobody used since it was stored is dropped
    expect(evicted).toBe(1);
    expect(await timed.getCachedBlock('bafyStale')).toBeNull();
    expect(await timed.getCachedBlock('bafyOld')).not.toBeNull();
    expect(await timed.getCachedBlock('bafyRecent')).not.toBeNull();
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
    // a matching `block_meta` row so the entry otherwise looks valid. It is
    // the shape a corrupted write or a future schema change could leave behind
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

  it('As a user opening a cached product, my block reads are answered while another read of the cache is still running', async () => {
    // Given a cached block, and a long read of the block store already running
    await cache.putCachedBlock('bafyA', new Uint8Array([1]));
    const db = await idb.connect();
    const events: string[] = [];
    const longRead = new Promise<void>((resolve, reject) => {
      const tx = db.transaction('blocks', 'readonly');
      const store = tx.objectStore('blocks');
      let left = 100;
      const next = (): void => {
        const request = store.get('bafyA');
        request.onsuccess = () => {
          left -= 1;
          if (left > 0) {
            next();
          }
        };
      };
      next();
      tx.oncomplete = () => {
        events.push('long read done');
        resolve();
      };
      tx.onerror = () => {
        reject(tx.error ?? new Error('long read failed'));
      };
    });

    // When
    const bytes = await cache.getCachedBlock('bafyA');
    events.push('block read');
    await longRead;

    // Then the block read did not wait for the long one
    expect(bytes).toEqual(new Uint8Array([1]));
    expect(events).toEqual(['block read', 'long read done']);
  });

  it('As a user opening a cached product, the blocks I read are marked used in fewer writes than reads', async () => {
    // Given ten cached blocks, and a count of the writes that mark blocks used
    let touchWrites = 0;
    const counted = createBlockCache(
      memoryIdb({
        onTransaction: tx => {
          if (isTouchWrite(tx)) {
            touchWrites += 1;
          }
        },
      }),
    );
    const cids = Array.from({ length: 10 }, (_, i) => `bafy${String(i)}`);
    for (const cid of cids) {
      await counted.putCachedBlock(cid, new Uint8Array([1]));
    }

    // When the product reads them all at once, and the visit ends with a prune that keeps everything
    await Promise.all(cids.map(cid => counted.getCachedBlock(cid)));
    await counted.pruneBlockCache(Number.MAX_SAFE_INTEGER);

    // Then
    expect(touchWrites).toBeGreaterThan(0);
    expect(touchWrites).toBeLessThan(cids.length);
  });

  it('As a user, the blocks I read stay marked used on my next visit, even when this visit never pruned', async () => {
    // Given three 3-byte blocks stored in order, and a signal for the write that marks a block used
    const touched = deferred<undefined>();
    const watched = memoryIdb({
      onTransaction: tx => {
        if (isTouchWrite(tx)) {
          tx.addEventListener('complete', () => {
            touched.resolve(undefined);
          });
        }
      },
    });
    const clock = manualTimers(1_000);
    const visit = createBlockCache(watched, clock);
    await visit.putCachedBlock('bafyOld', new Uint8Array(3));
    await clock.advance(1_000);
    await visit.putCachedBlock('bafyStale', new Uint8Array(3));
    await clock.advance(1_000);
    await visit.putCachedBlock('bafyRecent', new Uint8Array(3));

    // When I read the oldest again, and that mark is written
    await clock.advance(1_000);
    await visit.getCachedBlock('bafyOld');
    await touched.promise;

    // Then the next visit's prune drops only the block nobody used since it was stored
    const nextVisit = createBlockCache(watched, clock);
    expect(await nextVisit.pruneBlockCache(6)).toBe(1);
    expect(await nextVisit.getCachedBlock('bafyStale')).toBeNull();
    expect(await nextVisit.getCachedBlock('bafyOld')).not.toBeNull();
  });

  it('As a user, a block the relay deletes right after reading it leaves nothing that crowds out the blocks I keep', async () => {
    // Given two 3-byte blocks, the older one fetched twice at once
    const clock = manualTimers(1_000);
    const timed = createBlockCache(idb, clock);
    await timed.putCachedBlock('bafyBad', new Uint8Array(3));
    await clock.advance(1_000);
    await timed.putCachedBlock('bafyGood', new Uint8Array(3));
    await clock.advance(1_000);
    const fetches = [timed.getCachedBlock('bafyBad'), timed.getCachedBlock('bafyBad')];

    // When the relay deletes it as corrupt once the first fetch returns, and the cache is pruned to room for one block
    // The first fetch's mark is still being written then, so the other fetch's mark goes out after the delete.
    await Promise.race(fetches);
    await timed.deleteCachedBlock('bafyBad');
    await Promise.all(fetches);
    const evicted = await timed.pruneBlockCache(3);

    // Then the block I keep stays
    expect(evicted).toBe(0);
    expect(await timed.getCachedBlock('bafyGood')).toEqual(new Uint8Array(3));
  });
});

describe('block cache touch failures', () => {
  it('As an operator, a touch the browser refuses at commit is counted, and the block is still served', async () => {
    // Given a block cached a while ago, and a database that refuses every write that marks a block used
    const sentry = bindRecordingSentry({ onFinished: onTestFinished });
    const clock = manualTimers(1_000);
    const refusing = createBlockCache(
      memoryIdb({
        onTransaction: tx => {
          if (isTouchWrite(tx)) {
            abortAtCommit(tx);
          }
        },
      }),
      clock,
    );
    await refusing.putCachedBlock('bafyA', new Uint8Array([1, 2, 3]));
    await clock.advance(1_000);

    // When I read it, and a prune that keeps everything drains the bookkeeping
    const bytes = await refusing.getCachedBlock('bafyA');
    await refusing.pruneBlockCache(Number.MAX_SAFE_INTEGER);

    // Then the refused mark is counted, and the read still had the bytes
    expect(sentry.counted(S.CACHE_STORAGE)).toContainEqual(
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
