// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Origin-scoped IndexedDB storage for truapi-provider's warm-start blobs.
//
// The crate keeps nothing of its own, so without a store every chain syncs
// from its chain-spec checkpoint on every run. It calls `load` and `save`
// here, keyed by `0x`-prefixed genesis hash, and resumes a chain from the
// stored finalized state instead.

import { log } from "@dotli/shared/log";

const DB_NAME = "dotli-warm-store";
const STORE = "chain-databases";
const DB_VERSION = 1;
// Real warp-sync blobs are hundreds of KB. Anything smaller is truncated or
// garbage, and the light client may hang on it rather than discard it. The
// floor is enforced on both save and load so we never persist a blob the
// loader would later reject.
const MIN_VALID_BYTES = 100_000;
const MAX_VALID_BYTES = 8_000_000;
const IDB_TIMEOUT_MS = 3_000;

/**
 * Warm-start blob storage, in the shape `setStorage` expects.
 *
 * `load` resolves to the stored blob or `null` when nothing is stored yet. It
 * rejects rather than resolving `null` when the store cannot answer, because
 * an empty read is read as "nothing stored" and would let a later snapshot
 * overwrite good state.
 */
export interface WarmStore {
  load(genesisHash: string): Promise<string | null>;
  save(genesisHash: string, blob: string): Promise<void>;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => {
      resolve(req.result);
    };
    req.onerror = () => {
      reject(req.error ?? new Error("indexedDB.open failed"));
    };
  });
}

function withTimeout<T>(work: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${String(IDB_TIMEOUT_MS)}ms`));
    }, IDB_TIMEOUT_MS);
    work.then(resolve, reject).finally(() => {
      clearTimeout(timer);
    });
  });
}

async function read(genesisHash: string): Promise<string | null> {
  const db = await openDb();
  try {
    const raw = await new Promise<unknown>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(genesisHash);
      req.onsuccess = () => {
        resolve(req.result);
      };
      req.onerror = () => {
        reject(req.error ?? new Error("warm-store read failed"));
      };
    });
    if (typeof raw !== "string") {
      return null;
    }
    if (raw.length < MIN_VALID_BYTES) {
      log.warn(
        `[dot.li warm-store] Discarding undersized blob for ${genesisHash} (${String(raw.length)} bytes)`,
      );
      return null;
    }
    return raw;
  } finally {
    db.close();
  }
}

async function write(genesisHash: string, blob: string): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(blob, genesisHash);
      tx.oncomplete = () => {
        resolve();
      };
      tx.onerror = () => {
        reject(tx.error ?? new Error("warm-store write failed"));
      };
    });
  } finally {
    db.close();
  }
}

/** Returns `null` where IndexedDB is unavailable, so warm start stays off. */
export function createWarmStore(): WarmStore | null {
  if (typeof indexedDB === "undefined") {
    return null;
  }
  return {
    load: (genesisHash) => withTimeout(read(genesisHash), "warm-store load"),
    save: async (genesisHash, blob) => {
      if (blob.length < MIN_VALID_BYTES || blob.length > MAX_VALID_BYTES) {
        log.debug(
          `[dot.li warm-store] Skipping save for ${genesisHash} (${String(blob.length)} bytes)`,
        );
        return;
      }
      await withTimeout(write(genesisHash, blob), "warm-store save");
    },
  };
}
