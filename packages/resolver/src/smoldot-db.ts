// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// smoldot's finalized-database blobs per genesis hash. Without them every chain syncs from its checkpoint.

import { log } from '@dotli/shared';

const DB_NAME = 'dotli-smoldot-db';
const STORE = 'chain-databases';
// Last resume time per genesis hash. The SharedWorker's console is unreachable, so this is how warm
// start is observed from outside.
const LOADS_STORE = 'loads';
// The v1 store, dropped on upgrade so the browser reclaims megabytes nothing reads.
const V1_STORE = 'chain-db';
const DB_VERSION = 2;
// Real blobs are hundreds of KB. A smaller one is garbage the light client may hang on, so neither side keeps it.
const MIN_VALID_BYTES = 100_000;
// Room to grow over the largest checkpoint. Crossing it freezes the stored blob, hence a warning, not debug.
const MAX_VALID_BYTES = 32_000_000;
const IDB_TIMEOUT_MS = 3_000;

/**
 * The shape `setStorage` expects. `load` rejects when it cannot answer, since `null` would let a later
 * snapshot overwrite good state.
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
    // A tab on v1 blocks the upgrade, and blocked fires neither `success` nor `error`. Warm start degrades to cold.
    let settled = false;
    req.onblocked = () => {
      settled = true;
      reject(new Error(`${DB_NAME} upgrade to v${String(DB_VERSION)} is blocked by another tab`));
    };
    req.onsuccess = () => {
      if (settled) {
        // The blocking tab closed after we gave up.
        req.result.close();
        return;
      }
      resolve(req.result);
    };
    req.onerror = () => {
      settled = true;
      reject(req.error ?? new Error('indexedDB.open failed'));
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
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(genesisHash);
      req.onsuccess = () => {
        resolve(req.result);
      };
      req.onerror = () => {
        reject(req.error ?? new Error('smoldot-db read failed'));
      };
    });
    if (typeof raw !== 'string') {
      return null;
    }
    if (raw.length < MIN_VALID_BYTES) {
      log.warn(`[dot.li smoldot-db] Discarding undersized blob for ${genesisHash} (${String(raw.length)} bytes)`);
      return null;
    }
    return raw;
  } finally {
    db.close();
  }
}

// Never fails a resume, since losing the marker costs only visibility.
async function recordLoad(genesisHash: string): Promise<void> {
  try {
    const db = await openDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(LOADS_STORE, 'readwrite');
        tx.objectStore(LOADS_STORE).put(Date.now(), genesisHash);
        tx.oncomplete = () => {
          resolve();
        };
        tx.onerror = () => {
          reject(tx.error ?? new Error('smoldot-db load marker failed'));
        };
      });
    } finally {
      db.close();
    }
  } catch (error) {
    log.debug(`[dot.li smoldot-db] load marker failed for ${genesisHash}:`, error);
  }
}

async function write(genesisHash: string, blob: string): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(blob, genesisHash);
      tx.oncomplete = () => {
        resolve();
      };
      tx.onerror = () => {
        reject(tx.error ?? new Error('smoldot-db write failed'));
      };
    });
  } finally {
    db.close();
  }
}

/** Returns `null` where IndexedDB is unavailable, so warm start stays off. */
export function createSmoldotDb(): SmoldotDb | null {
  if (typeof indexedDB === 'undefined') {
    return null;
  }
  return {
    load: async genesisHash => {
      const blob = await withTimeout(read(genesisHash), 'smoldot-db load');
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
      await withTimeout(write(genesisHash, blob), 'smoldot-db save');
    },
  };
}
