// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Origin-scoped IndexedDB storage for smoldot's finalized-database blobs.
//
// The crate keeps nothing of its own, so without storage every chain syncs
// from its chain-spec checkpoint on every run. It calls `load` and `save`
// here, keyed by `0x`-prefixed genesis hash, and resumes a chain from the
// stored finalized state instead.

import { log } from "@dotli/shared/log";

const DB_NAME = "dotli-smoldot-db";
const STORE = "chain-databases";
// Which chains actually resumed from storage, by genesis hash, with the time
// of the most recent resume. The provider runs in a SharedWorker in the
// default backend, where its console and globals are unreachable, so this is
// the only place warm start can be observed from outside.
const LOADS_STORE = "loads";
// Version 1 of this database kept blobs in `chain-db`, keyed by network and
// chain name rather than genesis hash. Version 2 drops it, so an upgrading
// browser reclaims the space instead of carrying megabytes nothing reads.
const V1_STORE = "chain-db";
const DB_VERSION = 2;
// Real warp-sync blobs are hundreds of KB. Anything smaller is truncated or
// garbage, and the light client may hang on it rather than discard it. The
// floor is enforced on both save and load so we never persist a blob the
// loader would later reject.
const MIN_VALID_BYTES = 100_000;
// Asset Hub's fresh checkpoint measures ~3.6 MB, the largest of the catalog
// chains, so this leaves room to grow. Crossing it freezes whatever blob is
// already stored, which is why the skip below is a warning and not a debug
// line: the symptom is warm start quietly ageing into uselessness.
const MAX_VALID_BYTES = 32_000_000;
const IDB_TIMEOUT_MS = 3_000;

/**
 * Database-blob storage, in the shape `setStorage` expects.
 *
 * `load` resolves to the stored blob or `null` when nothing is stored yet. It
 * rejects rather than resolving `null` when the store cannot answer, because
 * an empty read is read as "nothing stored" and would let a later snapshot
 * overwrite good state.
 */
export interface SmoldotDb {
  load(genesisHash: string): Promise<string | null>;
  save(genesisHash: string, blob: string): Promise<void>;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of [STORE, LOADS_STORE]) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name);
        }
      }
      if (db.objectStoreNames.contains(V1_STORE)) {
        db.deleteObjectStore(V1_STORE);
      }
    };
    // A tab on the previous version holds the database at version 1, so the
    // upgrade cannot run. Without this the request never fires `success` or
    // `error`, and every caller waits on a promise that never settles. Give
    // up instead: warm start degrades to a cold sync, and the reason says so
    // rather than surfacing as a timeout.
    let settled = false;
    req.onblocked = () => {
      settled = true;
      reject(
        new Error(
          `${DB_NAME} upgrade to v${String(DB_VERSION)} is blocked by another tab`,
        ),
      );
    };
    req.onsuccess = () => {
      if (settled) {
        // The blocking tab closed after we gave up. Nothing is waiting on
        // this connection, so drop it rather than leaking it.
        req.result.close();
        return;
      }
      resolve(req.result);
    };
    req.onerror = () => {
      settled = true;
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
        reject(req.error ?? new Error("smoldot-db read failed"));
      };
    });
    if (typeof raw !== "string") {
      return null;
    }
    if (raw.length < MIN_VALID_BYTES) {
      log.warn(
        `[dot.li smoldot-db] Discarding undersized blob for ${genesisHash} (${String(raw.length)} bytes)`,
      );
      return null;
    }
    return raw;
  } finally {
    db.close();
  }
}

// Never blocks or fails a resume: losing the marker costs visibility, not
// warm start.
async function recordLoad(genesisHash: string): Promise<void> {
  try {
    const db = await openDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(LOADS_STORE, "readwrite");
        tx.objectStore(LOADS_STORE).put(Date.now(), genesisHash);
        tx.oncomplete = () => {
          resolve();
        };
        tx.onerror = () => {
          reject(tx.error ?? new Error("smoldot-db load marker failed"));
        };
      });
    } finally {
      db.close();
    }
  } catch (error) {
    log.debug(
      `[dot.li smoldot-db] load marker failed for ${genesisHash}:`,
      error,
    );
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
        reject(tx.error ?? new Error("smoldot-db write failed"));
      };
    });
  } finally {
    db.close();
  }
}

/** Returns `null` where IndexedDB is unavailable, so warm start stays off. */
export function createSmoldotDb(): SmoldotDb | null {
  if (typeof indexedDB === "undefined") {
    return null;
  }
  return {
    load: async (genesisHash) => {
      const blob = await withTimeout(read(genesisHash), "smoldot-db load");
      if (blob !== null) {
        void recordLoad(genesisHash);
      }
      return blob;
    },
    save: async (genesisHash, blob) => {
      if (blob.length < MIN_VALID_BYTES) {
        log.debug(
          `[dot.li smoldot-db] Skipping save for ${genesisHash} (${String(blob.length)} bytes, below the floor)`,
        );
        return;
      }
      if (blob.length > MAX_VALID_BYTES) {
        log.warn(
          `[dot.li smoldot-db] Blob for ${genesisHash} is ${String(blob.length)} bytes, over the ${String(MAX_VALID_BYTES)} ceiling. Keeping the stored blob, which will not refresh.`,
        );
        return;
      }
      await withTimeout(write(genesisHash, blob), "smoldot-db save");
    },
  };
}
