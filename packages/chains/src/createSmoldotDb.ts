// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// smoldot's finalized-database blobs per genesis hash. Without them every chain syncs from its checkpoint.

import { waitForIdbRequest, runIdbTransaction, log, openIdb, withTimeout } from '@dotli/shared';

/** The shape `setStorage` expects. */
export type SmoldotDb = NonNullable<ReturnType<typeof createSmoldotDb>>;

type Params = {
  /** The IndexedDB the blobs live in, the page's own by default. `null` keeps warm start off. */
  factory?: IDBFactory | null;
};

type WriteParams = {
  /** The IndexedDB the blob goes to. */
  factory: IDBFactory;
  /** The chain the blob belongs to. */
  genesisHash: string;
  /** smoldot's database blob for the chain. */
  blob: string;
};

export const SMOLDOT_DB_NAME = 'dotli-smoldot-db';
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

/** Over `factory`, the page's IndexedDB by default. Returns `null` without one, so warm start stays off. */
export function createSmoldotDb({ factory = getPageIndexedDb() }: Params = {}) {
  if (factory === null) {
    return null;
  }
  return {
    /**
     * The chain's stored blob, or `null` when none is kept. Rejects when it cannot answer, since `null` would let a
     * later snapshot overwrite good state.
     */
    async load(genesisHash: string): Promise<string | null> {
      const blob = await withTimeout({
        work: read(factory, genesisHash),
        ms: IDB_TIMEOUT_MS,
        timeoutError: () => new Error(`smoldot-db load timed out after ${String(IDB_TIMEOUT_MS)}ms`),
      });
      if (blob !== null) {
        void recordLoad(factory, genesisHash);
      }
      return blob;
    },
    /** Stores the chain's blob, skipping one outside the valid size. Rejects when the write fails or times out. */
    async save(genesisHash: string, blob: string): Promise<void> {
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
      await withTimeout({
        work: write({ factory, genesisHash, blob }),
        ms: IDB_TIMEOUT_MS,
        timeoutError: () => new Error(`smoldot-db save timed out after ${String(IDB_TIMEOUT_MS)}ms`),
      });
    },
  };
}

function upgradeSmoldotDb(db: IDBDatabase): void {
  for (const name of [STORE, LOADS_STORE]) {
    if (!db.objectStoreNames.contains(name)) {
      db.createObjectStore(name);
    }
  }
  if (db.objectStoreNames.contains(V1_STORE)) {
    db.deleteObjectStore(V1_STORE);
  }
}

// A tab on v1 blocks the upgrade, which rejects, so warm start degrades to cold.
function openDb(factory: IDBFactory): Promise<IDBDatabase> {
  return openIdb({ factory, name: SMOLDOT_DB_NAME, version: DB_VERSION, upgrade: upgradeSmoldotDb });
}

async function read(factory: IDBFactory, genesisHash: string): Promise<string | null> {
  const db = await openDb(factory);
  try {
    const raw: unknown = await waitForIdbRequest(db.transaction(STORE, 'readonly').objectStore(STORE).get(genesisHash));
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
async function recordLoad(factory: IDBFactory, genesisHash: string): Promise<void> {
  try {
    const db = await openDb(factory);
    try {
      await runIdbTransaction({
        db,
        stores: LOADS_STORE,
        mode: 'readwrite',
        body: transaction => {
          transaction.objectStore(LOADS_STORE).put(Date.now(), genesisHash);
        },
      });
    } finally {
      db.close();
    }
  } catch (error) {
    log.debug(`[dot.li smoldot-db] load marker failed for ${genesisHash}:`, error);
  }
}

async function write({ factory, genesisHash, blob }: WriteParams): Promise<void> {
  const db = await openDb(factory);
  try {
    await runIdbTransaction({
      db,
      stores: STORE,
      mode: 'readwrite',
      body: transaction => {
        transaction.objectStore(STORE).put(blob, genesisHash);
      },
    });
  } finally {
    db.close();
  }
}

/** The page's IndexedDB, null where it has none. */
function getPageIndexedDb(): IDBFactory | null {
  return typeof indexedDB === 'undefined' ? null : indexedDB;
}
