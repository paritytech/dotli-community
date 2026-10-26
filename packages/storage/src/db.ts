// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The "dotli", "dotli-wallet" and "dotli-site-grants" IndexedDB connections, each opened on first use.

import { createAsyncTaskPool, openIdb } from '@dotli/shared';
import {
  DB_NAME,
  DB_VERSION,
  SITE_GRANTS_DB_NAME,
  SITE_GRANTS_DB_VERSION,
  upgradeDotliDb,
  upgradeSiteGrantsDb,
  upgradeWalletDb,
  WALLET_DB_NAME,
  WALLET_DB_VERSION,
} from './schema.js';

/**
 * A connection closing under unload or another tab's upgrade, or an open blocked by an older tab.
 * The next access reopens, so these are not faults.
 */
export function isExpectedDbError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  if (err.message.includes('blocked by another tab')) {
    return true;
  }
  // Browsers word the message differently ("is closing", "is no longer usable").
  return (err.name === 'InvalidStateError' || err.name === 'AbortError') && /clos|no longer/i.test(err.message);
}

/**
 * One connection shared by every read, opened by `open` on first use. A connection that closes, or that another tab's
 * upgrade asks to close, is dropped, and a failed open is not retried: the next read opens again, which is when it can
 * succeed.
 */
export function createDbConnection(open: () => Promise<IDBDatabase>): () => Promise<IDBDatabase> {
  let current: IDBDatabase | null = null;
  // Reads that overlap an open wait for it instead of opening their own.
  const opens = createAsyncTaskPool({ poolSize: 1 });
  return () =>
    opens.call(async () => {
      if (current !== null) {
        return current;
      }
      const db = await open();
      current = db;
      // Only this handle's own close drops it, so a late close of a replaced one keeps the newer.
      const release = (): void => {
        if (current === db) {
          current = null;
        }
      };
      db.onclose = release;
      db.onversionchange = () => {
        db.close();
        release();
      };
      return db;
    });
}

/**
 * The page's one connection. `indexedDB` is read at each open, as a context without it, such as the build, still
 * loads this module.
 */
const getDb = createDbConnection(() => openIdb(indexedDB, DB_NAME, DB_VERSION, upgradeDotliDb));

/** The IndexedDB a store reads and writes: its connection, and key ranges of the same implementation. */
export interface DotliIdb {
  connect: () => Promise<IDBDatabase>;
  /** Read at use, as a context without IndexedDB, such as the build, still loads the stores. */
  keyRange: () => typeof IDBKeyRange;
}

/** The page's own IndexedDB. */
export const pageIdb: DotliIdb = { connect: getDb, keyRange: () => IDBKeyRange };

const getWalletDb = createDbConnection(() => openIdb(indexedDB, WALLET_DB_NAME, WALLET_DB_VERSION, upgradeWalletDb));

/** The frame's wallet database, apart from the page's so no cleanup of that one can reach it. */
export const walletIdb: DotliIdb = { connect: getWalletDb, keyRange: () => IDBKeyRange };

const getSiteGrantsDb = createDbConnection(() =>
  openIdb(indexedDB, SITE_GRANTS_DB_NAME, SITE_GRANTS_DB_VERSION, upgradeSiteGrantsDb),
);

/** The session windows' grants database, apart from the page's so no cleanup of that one can reach it. */
export const siteGrantsIdb: DotliIdb = { connect: getSiteGrantsDb, keyRange: () => IDBKeyRange };
