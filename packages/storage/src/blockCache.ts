// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Host-side cache of bitswap blocks, since the credentialless sandbox loses its storage on every reload.
// No hash checks here, the relay verifies each block. Bookkeeping sits apart so touch and prune skip the bytes.

import { createCacheReporter } from './createCacheReporter.js';
import { pageIdb, type DotliIdb } from './db.js';
import { unsafe_readStoredRecord } from './unsafe_readStoredRecord.js';
import { createAsyncTaskPool, waitForIdbRequest, runIdbTransaction, realTimers, type Timers } from '@dotli/shared';

const BLOCKS = 'blocks';
const META = 'block_meta';
const BY_LAST_USED = 'byLastUsed';
const BOOKKEEPING = 'bookkeeping';

type BlockEntry = {
  cid: string;
  bytes: Uint8Array;
};

type BlockMeta = {
  cid: string;
  size: number;
  lastUsed: number;
};

type Params = {
  /** The database the blocks live in. */
  idb?: DotliIdb;
  /** The clock that marks a block used. */
  timers?: Pick<Timers, 'now'>;
};

// Module scope is the page, so each action's fault is captured once per page.
const reportFailure = createCacheReporter({ cache: 'block_cache', tag: '[dot.li block-cache]' });

/** The block cache over `idb` and the clock in `timers`, the page's own by default. */
export function createBlockCache({ idb = pageIdb, timers = realTimers }: Params = {}) {
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
      await runIdbTransaction({
        db,
        stores: META,
        mode: 'readwrite',
        body: transaction => {
          const store = transaction.objectStore(META);
          for (const [cid, lastUsed] of touches) {
            const request = store.get(cid);
            // A block deleted or cleared meanwhile stays gone, and a newer write keeps its later time.
            request.onsuccess = () => {
              const row = unsafe_readStoredRecord<BlockMeta | undefined>(request.result);
              if (row !== undefined && row.lastUsed < lastUsed) {
                store.put({ ...row, lastUsed } satisfies BlockMeta);
              }
            };
          }
        },
      });
    } catch (error) {
      reportFailure('touch', error);
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

  async function get(cid: string): Promise<Uint8Array | null> {
    let entry: BlockEntry | undefined;
    try {
      const db = await idb.connect();
      entry = unsafe_readStoredRecord<BlockEntry | undefined>(
        await waitForIdbRequest(db.transaction(BLOCKS, 'readonly').objectStore(BLOCKS).get(cid)),
      );
    } catch (error) {
      reportFailure('read', error);
      return null;
    }
    // Corrupt or from a future schema.
    if (entry === undefined || !(entry.bytes instanceof Uint8Array)) {
      return null;
    }
    touch(cid);
    return entry.bytes;
  }

  async function put(cid: string, bytes: Uint8Array): Promise<void> {
    try {
      const db = await idb.connect();
      const entry: BlockEntry = { cid, bytes };
      await runIdbTransaction({
        db,
        stores: [BLOCKS, META],
        mode: 'readwrite',
        body: transaction => {
          transaction.objectStore(BLOCKS).put(entry);
          transaction.objectStore(META).put(createBlockMeta({ cid, size: bytes.byteLength, lastUsed: timers.now() }));
        },
      });
    } catch (error) {
      reportFailure('write', error);
    }
  }

  async function remove(cid: string): Promise<void> {
    try {
      const db = await idb.connect();
      await runIdbTransaction({
        db,
        stores: [BLOCKS, META],
        mode: 'readwrite',
        body: transaction => {
          transaction.objectStore(BLOCKS).delete(cid);
          transaction.objectStore(META).delete(cid);
        },
      });
    } catch (error) {
      reportFailure('delete', error);
    }
  }

  async function clear(): Promise<boolean> {
    try {
      const db = await idb.connect();
      await runIdbTransaction({
        db,
        stores: [BLOCKS, META],
        mode: 'readwrite',
        body: transaction => {
          transaction.objectStore(BLOCKS).clear();
          transaction.objectStore(META).clear();
        },
      });
      return true;
    } catch (error) {
      reportFailure('clear', error);
      return false;
    }
  }

  async function pruneEntries(maxBytes: number): Promise<number> {
    try {
      const db = await idb.connect();
      let evicted = 0;
      await runIdbTransaction({
        db,
        stores: [BLOCKS, META],
        mode: 'readwrite',
        body: transaction => {
          const blocks = transaction.objectStore(BLOCKS);
          const cursorRequest = transaction.objectStore(META).index(BY_LAST_USED).openCursor(null, 'prev');
          let kept = 0;
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;
            if (cursor === null) {
              return;
            }
            const entry = unsafe_readStoredRecord<BlockMeta>(cursor.value);
            kept += entry.size;
            if (kept > maxBytes) {
              blocks.delete(entry.cid);
              cursor.delete();
              evicted += 1;
            }
            cursor.continue();
          };
        },
      });
      return evicted;
    } catch (error) {
      reportFailure('prune', error);
      return 0;
    }
  }

  function prune(maxBytes: number): Promise<number> {
    return bookkeeping.call(
      async () => {
        await flushTouches();
        return pruneEntries(maxBytes);
      },
      { pool: BOOKKEEPING },
    );
  }

  return {
    /** Resolves `null` on a miss or a storage failure. */
    get,
    /** Best-effort, a failure is reported here and never reaches the caller. */
    put,
    /** Best-effort, a failure is reported here and never reaches the caller. */
    remove,
    /** Resolves false when the clear failed, after reporting it, so the caller does not report it again. */
    clear,
    /** Drop the least recently used blocks down to `maxBytes`. Never rejects, a failure is reported here and resolves 0. */
    prune,
  };
}

export type BlockCache = ReturnType<typeof createBlockCache>;

/** The page's block cache. */
export const blockCache = createBlockCache();

function createBlockMeta({ cid, size, lastUsed }: BlockMeta): BlockMeta {
  return { cid, size, lastUsed };
}
