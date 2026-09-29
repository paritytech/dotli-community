// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// dot.li IndexedDB cache of content blocks, keyed by CID.
//
// The host relays every bitswap block a sandbox asks for, so it keeps them
// here and answers the next load of the same app without the network. The
// sandbox can't keep them itself: its iframe is credentialless, so its
// storage is dropped on every reload.
//
// This module only moves bytes. The relay hash-checks each block against its
// CID before storing it and after reading it back (`listenForSandboxBitswap`
// in `@dotli/content/bitswap`).
//
// Bytes and bookkeeping live in separate stores, so touching a block on read
// and walking the cache to prune it never load the bytes.

import { getDb } from "./db";
import { log } from "@dotli/shared/log";
import { captureException } from "@dotli/metrics/sentry";

const BLOCKS = "blocks";
const META = "block_meta";
const BY_LAST_USED = "byLastUsed";

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
      reject(tx.error ?? new Error("IDB transaction error"));
    };
    tx.onabort = () => {
      reject(tx.error ?? new Error("IDB transaction aborted"));
    };
  });
}

function report(action: string, err: unknown): void {
  log.error(`[dot.li block-cache] ${action} error:`, err);
  captureException(err, { kind: `block_cache_${action}_error` });
}

function meta(cid: string, size: number): BlockMeta {
  return { cid, size, lastUsed: Date.now() };
}

/** The cached bytes for `cid`, or `null` on a miss or a storage failure. */
export async function getCachedBlock(cid: string): Promise<Uint8Array | null> {
  try {
    const db = await getDb();
    const tx = db.transaction([BLOCKS, META], "readwrite");
    const request = tx.objectStore(BLOCKS).get(cid);
    return await new Promise<Uint8Array | null>((resolve, reject) => {
      request.onsuccess = () => {
        const entry = request.result as BlockEntry | undefined;
        if (entry === undefined) {
          resolve(null);
          return;
        }
        // Reading a block is using it, so it outlives blocks nobody asked for.
        tx.objectStore(META).put(meta(cid, entry.bytes.byteLength));
        resolve(entry.bytes);
      };
      request.onerror = () => {
        reject(request.error ?? new Error("IDB read error"));
      };
    });
  } catch (err) {
    report("read", err);
    return null;
  }
}

/** Keep `bytes` as the block for `cid`. Best-effort: failures are logged. */
export async function putCachedBlock(
  cid: string,
  bytes: Uint8Array,
): Promise<void> {
  try {
    const db = await getDb();
    const tx = db.transaction([BLOCKS, META], "readwrite");
    const entry: BlockEntry = { cid, bytes };
    tx.objectStore(BLOCKS).put(entry);
    tx.objectStore(META).put(meta(cid, bytes.byteLength));
    await completion(tx);
  } catch (err) {
    report("write", err);
  }
}

/** Forget the block for `cid`. Best-effort: failures are logged. */
export async function deleteCachedBlock(cid: string): Promise<void> {
  try {
    const db = await getDb();
    const tx = db.transaction([BLOCKS, META], "readwrite");
    tx.objectStore(BLOCKS).delete(cid);
    tx.objectStore(META).delete(cid);
    await completion(tx);
  } catch (err) {
    report("delete", err);
  }
}

/** Forget every block. Used when the user turns the archive cache off. */
export async function clearBlockCache(): Promise<void> {
  try {
    const db = await getDb();
    const tx = db.transaction([BLOCKS, META], "readwrite");
    tx.objectStore(BLOCKS).clear();
    tx.objectStore(META).clear();
    await completion(tx);
  } catch (err) {
    report("clear", err);
  }
}

/**
 * Drop the least recently used blocks until the cache holds at most
 * `maxBytes`. Returns how many blocks it dropped.
 */
export async function pruneBlockCache(maxBytes: number): Promise<number> {
  try {
    const db = await getDb();
    const tx = db.transaction([BLOCKS, META], "readwrite");
    const blocks = tx.objectStore(BLOCKS);
    const cursorRequest = tx
      .objectStore(META)
      .index(BY_LAST_USED)
      .openCursor(null, "prev");
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
    report("prune", err);
    return 0;
  }
}
