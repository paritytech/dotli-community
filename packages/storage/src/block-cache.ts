// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Host-side cache of bitswap blocks, since the credentialless sandbox loses its storage on every reload.
// No hash checks here, the relay verifies each block. Bookkeeping sits apart so touch and prune skip the bytes.

import { createCacheReporter } from './cache-reporter.js';
import { pageIdb, type DotliIdb } from './db.js';
import { createAsyncTaskPool, idbRequest, idbTransaction, realTimers, type Timers } from '@dotli/shared';

const BLOCKS = 'blocks';
const META = 'block_meta';
const BY_LAST_USED = 'byLastUsed';
const BOOKKEEPING = 'bookkeeping';

interface BlockEntry {
  cid: string;
  bytes: Uint8Array;
}

interface BlockMeta {
  cid: string;
  size: number;
  lastUsed: number;
}

// Module scope is the page, so each action's fault is captured once per page.
const reportFailure = createCacheReporter('block_cache', '[dot.li block-cache]');

function meta(cid: string, size: number, lastUsed: number): BlockMeta {
  return { cid, size, lastUsed };
}

/** The block cache over `idb` and the clock in `timers`, the page's own by default. */
export function createBlockCache(idb: DotliIdb = pageIdb, timers: Pick<Timers, 'now'> = realTimers) {
  // A read that wrote its own touch would take a write lock, and write locks on one store run one at a time. So a read
  // leaves its touch here, and the touches waiting go out together.
  const pendingTouches = new Map<string, number>();
  // Touch writes and prunes share one queue, so a prune ranks blocks after every touch before it.
  const bookkeeping = createAsyncTaskPool({ poolSize: 1 });

  /** Writes the waiting touches in one transaction. A flush that a prune ran ahead of finds none left and returns. */
  async function flushTouches(): Promise<void> {
    if (pendingTouches.size === 0) {
      return;
    }
    const touches = new Map(pendingTouches);
    pendingTouches.clear();
    try {
      const db = await idb.connect();
      await idbTransaction(db, META, 'readwrite', tx => {
        const store = tx.objectStore(META);
        for (const [cid, lastUsed] of touches) {
          const request = store.get(cid) as IDBRequest<BlockMeta | undefined>;
          // A block deleted or cleared meanwhile stays gone, and a newer write keeps its later time.
          request.onsuccess = () => {
            const row = request.result;
            if (row !== undefined && row.lastUsed < lastUsed) {
              store.put({ ...row, lastUsed } satisfies BlockMeta);
            }
          };
        }
      });
    } catch (err) {
      reportFailure('touch', err);
    }
  }

  function touch(cid: string): void {
    // Every flush empties the map as it starts, so only the touch that fills an empty map is owed a flush of its own.
    const owed = pendingTouches.size === 0;
    pendingTouches.set(cid, timers.now());
    if (owed) {
      void bookkeeping.call(flushTouches, { pool: BOOKKEEPING });
    }
  }

  /** Resolves `null` on a miss or a storage failure. */
  async function getCachedBlock(cid: string): Promise<Uint8Array | null> {
    let entry: BlockEntry | undefined;
    try {
      const db = await idb.connect();
      entry = (await idbRequest(db.transaction(BLOCKS, 'readonly').objectStore(BLOCKS).get(cid))) as
        BlockEntry | undefined;
    } catch (err) {
      reportFailure('read', err);
      return null;
    }
    // Corrupt or from a future schema.
    if (entry === undefined || !(entry.bytes instanceof Uint8Array)) {
      return null;
    }
    touch(cid);
    return entry.bytes;
  }

  /** Best-effort, a failure is reported here and never reaches the caller. */
  async function putCachedBlock(cid: string, bytes: Uint8Array): Promise<void> {
    try {
      const db = await idb.connect();
      const entry: BlockEntry = { cid, bytes };
      await idbTransaction(db, [BLOCKS, META], 'readwrite', tx => {
        tx.objectStore(BLOCKS).put(entry);
        tx.objectStore(META).put(meta(cid, bytes.byteLength, timers.now()));
      });
    } catch (err) {
      reportFailure('write', err);
    }
  }

  /** Best-effort, a failure is reported here and never reaches the caller. */
  async function deleteCachedBlock(cid: string): Promise<void> {
    try {
      const db = await idb.connect();
      await idbTransaction(db, [BLOCKS, META], 'readwrite', tx => {
        tx.objectStore(BLOCKS).delete(cid);
        tx.objectStore(META).delete(cid);
      });
    } catch (err) {
      reportFailure('delete', err);
    }
  }

  /** Resolves false when the clear failed, after reporting it, so the caller does not report it again. */
  async function clearBlockCache(): Promise<boolean> {
    try {
      const db = await idb.connect();
      await idbTransaction(db, [BLOCKS, META], 'readwrite', tx => {
        tx.objectStore(BLOCKS).clear();
        tx.objectStore(META).clear();
      });
      return true;
    } catch (err) {
      reportFailure('clear', err);
      return false;
    }
  }

  async function prune(maxBytes: number): Promise<number> {
    try {
      const db = await idb.connect();
      let evicted = 0;
      await idbTransaction(db, [BLOCKS, META], 'readwrite', tx => {
        const blocks = tx.objectStore(BLOCKS);
        const cursorRequest = tx.objectStore(META).index(BY_LAST_USED).openCursor(null, 'prev');
        let kept = 0;
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (cursor === null) {
            return;
          }
          const entry = cursor.value as BlockMeta;
          kept += entry.size;
          if (kept > maxBytes) {
            blocks.delete(entry.cid);
            cursor.delete();
            evicted += 1;
          }
          cursor.continue();
        };
      });
      return evicted;
    } catch (err) {
      reportFailure('prune', err);
      return 0;
    }
  }

  /** Drop the least recently used blocks down to `maxBytes`. Resolves the number dropped. */
  function pruneBlockCache(maxBytes: number): Promise<number> {
    return bookkeeping.call(
      async () => {
        await flushTouches();
        return prune(maxBytes);
      },
      { pool: BOOKKEEPING },
    );
  }

  return { getCachedBlock, putCachedBlock, deleteCachedBlock, clearBlockCache, pruneBlockCache };
}

export type BlockCache = ReturnType<typeof createBlockCache>;

export const { getCachedBlock, putCachedBlock, deleteCachedBlock, clearBlockCache, pruneBlockCache }: BlockCache =
  createBlockCache();
