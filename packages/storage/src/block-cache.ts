// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Host-side cache of bitswap blocks, since the credentialless sandbox loses its storage on every reload.
// No hash checks here, the relay verifies each block. Bookkeeping sits apart so touch and prune skip the bytes.

import { createCacheReporter } from './cache-reporter.js';
import { pageIdb, type DotliIdb } from './db.js';
import { idbTransaction, log } from '@dotli/shared';

const BLOCKS = 'blocks';
const META = 'block_meta';
const BY_LAST_USED = 'byLastUsed';

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

function report(action: string, err: unknown): void {
  const name = err instanceof Error ? err.name : undefined;
  if (name === 'QuotaExceededError') {
    // Expected under storage pressure, so it is logged but never reported.
    log.warn(`[dot.li block-cache] ${action} error:`, err);
    return;
  }
  reportFailure(action, err);
}

function meta(cid: string, size: number): BlockMeta {
  return { cid, size, lastUsed: Date.now() };
}

/** The block cache over `idb`, the page's own by default. */
export function createBlockCache(idb: DotliIdb = pageIdb) {
  /** Resolves `null` on a miss or a storage failure. */
  async function getCachedBlock(cid: string): Promise<Uint8Array | null> {
    try {
      const db = await idb.connect();
      const tx = db.transaction([BLOCKS, META], 'readwrite');
      const request = tx.objectStore(BLOCKS).get(cid);
      let settled = false;
      // Not the transaction helper: the read answers as soon as it succeeds, before its touch commits.
      return await new Promise<Uint8Array | null>(resolve => {
        // Read and touch share one transaction and its error handlers. A failure after `settled` is the
        // touch, which the caller never sees.
        const settle = (value: Uint8Array | null): void => {
          if (settled) {
            return;
          }
          settled = true;
          resolve(value);
        };
        request.onsuccess = () => {
          const entry = request.result as BlockEntry | undefined;
          // Corrupt or from a future schema.
          if (entry === undefined || !(entry.bytes instanceof Uint8Array)) {
            settle(null);
            return;
          }
          settle(entry.bytes);
          tx.objectStore(META).put(meta(cid, entry.bytes.byteLength));
        };
        // A failed request fires both `onerror` and `onabort`.
        let reported = false;
        const fail = (err: Error): void => {
          if (!reported) {
            reported = true;
            report(settled ? 'touch' : 'read', err);
          }
          settle(null);
        };
        tx.onerror = event => {
          // `tx.error` is still null while the failing request bubbles, so the request carries the cause.
          const failed = event.target as IDBRequest | null;
          fail(failed?.error ?? tx.error ?? new Error('IDB transaction error'));
        };
        tx.onabort = () => {
          fail(tx.error ?? new Error('IDB transaction aborted'));
        };
      });
    } catch (err) {
      report('read', err);
      return null;
    }
  }

  /** Best-effort, failures are only logged. */
  async function putCachedBlock(cid: string, bytes: Uint8Array): Promise<void> {
    try {
      const db = await idb.connect();
      const entry: BlockEntry = { cid, bytes };
      await idbTransaction(db, [BLOCKS, META], 'readwrite', tx => {
        tx.objectStore(BLOCKS).put(entry);
        tx.objectStore(META).put(meta(cid, bytes.byteLength));
      });
    } catch (err) {
      report('write', err);
    }
  }

  /** Best-effort, failures are only logged. */
  async function deleteCachedBlock(cid: string): Promise<void> {
    try {
      const db = await idb.connect();
      await idbTransaction(db, [BLOCKS, META], 'readwrite', tx => {
        tx.objectStore(BLOCKS).delete(cid);
        tx.objectStore(META).delete(cid);
      });
    } catch (err) {
      report('delete', err);
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
      report('clear', err);
      return false;
    }
  }

  /** Drop the least recently used blocks down to `maxBytes`. Resolves the number dropped. */
  async function pruneBlockCache(maxBytes: number): Promise<number> {
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
      report('prune', err);
      return 0;
    }
  }

  return { getCachedBlock, putCachedBlock, deleteCachedBlock, clearBlockCache, pruneBlockCache };
}

export type BlockCache = ReturnType<typeof createBlockCache>;

export const { getCachedBlock, putCachedBlock, deleteCachedBlock, clearBlockCache, pruneBlockCache }: BlockCache =
  createBlockCache();
