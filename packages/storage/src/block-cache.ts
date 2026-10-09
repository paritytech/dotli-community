// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Host-side cache of bitswap blocks, since the credentialless sandbox loses its storage on every reload.
// No hash checks here, the relay verifies each block. Bookkeeping sits apart so touch and prune skip the bytes.

import { getDb, isExpectedDbError } from './db.js';
import { log } from '@dotli/shared';
import { captureException, recordExpected } from '@dotli/metrics';

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

function completion(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => {
      resolve();
    };
    tx.onerror = () => {
      reject(tx.error ?? new Error('IDB transaction error'));
    };
    tx.onabort = () => {
      reject(tx.error ?? new Error('IDB transaction aborted'));
    };
  });
}

// One Sentry capture per action per page, since every read on a stuck cache would report identically.
const reportedActions = new Set<string>();

function report(action: string, err: unknown): void {
  const step = `block_cache_${action}`;
  if (isExpectedDbError(err)) {
    recordExpected(err, { flow: 'storage', step });
    return;
  }
  const name = err instanceof Error ? err.name : undefined;
  if (name === 'QuotaExceededError') {
    // Expected under storage pressure, so it is logged but never reported.
    log.warn(`[dot.li block-cache] ${action} error:`, err);
    return;
  }
  log.error(`[dot.li block-cache] ${action} error:`, err);
  if (reportedActions.has(action)) {
    return;
  }
  reportedActions.add(action);
  captureException(err, { flow: 'storage', step, tags: { kind: `${step}_error` } });
}

function meta(cid: string, size: number): BlockMeta {
  return { cid, size, lastUsed: Date.now() };
}

/** Resolves `null` on a miss or a storage failure. */
export async function getCachedBlock(cid: string): Promise<Uint8Array | null> {
  try {
    const db = await getDb();
    const tx = db.transaction([BLOCKS, META], 'readwrite');
    const request = tx.objectStore(BLOCKS).get(cid);
    let settled = false;
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
export async function putCachedBlock(cid: string, bytes: Uint8Array): Promise<void> {
  try {
    const db = await getDb();
    const tx = db.transaction([BLOCKS, META], 'readwrite');
    const entry: BlockEntry = { cid, bytes };
    tx.objectStore(BLOCKS).put(entry);
    tx.objectStore(META).put(meta(cid, bytes.byteLength));
    await completion(tx);
  } catch (err) {
    report('write', err);
  }
}

/** Best-effort, failures are only logged. */
export async function deleteCachedBlock(cid: string): Promise<void> {
  try {
    const db = await getDb();
    const tx = db.transaction([BLOCKS, META], 'readwrite');
    tx.objectStore(BLOCKS).delete(cid);
    tx.objectStore(META).delete(cid);
    await completion(tx);
  } catch (err) {
    report('delete', err);
  }
}

export async function clearBlockCache(): Promise<void> {
  try {
    const db = await getDb();
    const tx = db.transaction([BLOCKS, META], 'readwrite');
    tx.objectStore(BLOCKS).clear();
    tx.objectStore(META).clear();
    await completion(tx);
  } catch (err) {
    report('clear', err);
  }
}

/** Drop the least recently used blocks down to `maxBytes`. Resolves the number dropped. */
export async function pruneBlockCache(maxBytes: number): Promise<number> {
  try {
    const db = await getDb();
    const tx = db.transaction([BLOCKS, META], 'readwrite');
    const blocks = tx.objectStore(BLOCKS);
    const cursorRequest = tx.objectStore(META).index(BY_LAST_USED).openCursor(null, 'prev');
    let kept = 0;
    let evicted = 0;
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
    await completion(tx);
    return evicted;
  } catch (err) {
    report('prune', err);
    return 0;
  }
}
