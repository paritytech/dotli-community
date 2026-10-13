// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The one "dotli" IndexedDB connection, pre-opened during HTML parse by `preOpenDotliDb` (`window.__dotliDb`).

import { createAsyncTaskPool, log } from '@dotli/shared';
import { captureException, recordExpected } from '@dotli/metrics';
import { DB_NAME, DB_VERSION, openDotliDb, upgradeDotliDb } from './schema.js';

declare global {
  interface Window {
    __dotliDb?: Promise<IDBDatabase>;
  }
}

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

export interface DbConnectionDeps {
  /** Opens a fresh connection on the current schema. */
  open: () => Promise<IDBDatabase>;
  /** The page's own open, started during HTML parse, handed over once. */
  takePreOpened: () => Promise<IDBDatabase> | undefined;
}

function reportPreOpenFailure(err: unknown): void {
  if (isExpectedDbError(err)) {
    recordExpected(err, { flow: 'storage', step: 'db_open' });
    return;
  }
  log.error('[dot.li db] Pre-opened DB handle rejected; falling back to fresh open:', err);
  captureException(err, { flow: 'storage', step: 'db_open', tags: { kind: 'db_pre_opened_rejected' } });
}

/**
 * One connection shared by every read. A connection that closes, or that another tab's upgrade asks to close, is
 * dropped, and a failed open is not retried: the next read opens again, which is when it can succeed.
 */
export function createDbConnection(deps: DbConnectionDeps): () => Promise<IDBDatabase> {
  let current: IDBDatabase | null = null;
  // Reads that overlap an open wait for it instead of opening their own.
  const opens = createAsyncTaskPool({ poolSize: 1 });

  async function openOnce(): Promise<IDBDatabase> {
    const preOpened = deps.takePreOpened();
    if (preOpened === undefined) {
      return deps.open();
    }
    try {
      return await preOpened;
    } catch (err: unknown) {
      reportPreOpenFailure(err);
      return deps.open();
    }
  }

  return () =>
    opens.call(async () => {
      if (current !== null) {
        return current;
      }
      const db = await openOnce();
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

/** Where the HTML-parse pre-open leaves its handle, which is `window` on the page. */
export interface PreOpenSlot {
  __dotliDb?: Promise<IDBDatabase> | undefined;
}

export interface PageDbDeps {
  /** Read at each open, as a context without IndexedDB, such as the build, still loads this module. */
  factory: () => IDBFactory;
  /** Undefined outside a window, which has no pre-open. */
  slot: PreOpenSlot | undefined;
}

/** A connection on the current schema, reusing the pre-opened handle once. A rejected pre-open is reported before the fresh open. */
export function createPageDb({ factory, slot }: PageDbDeps): () => Promise<IDBDatabase> {
  return createDbConnection({
    open: () => openDotliDb(factory(), DB_NAME, DB_VERSION, upgradeDotliDb),
    takePreOpened: () => {
      if (slot === undefined) {
        return undefined;
      }
      const preOpened = slot.__dotliDb;
      // One use only, so a reopen after close gets a new handle and a rejected pre-open is reported once.
      delete slot.__dotliDb;
      return preOpened;
    },
  });
}

/** The page's one connection. */
const getDb = createPageDb({
  factory: () => indexedDB,
  slot: typeof window === 'undefined' ? undefined : window,
});

/** The IndexedDB a store reads and writes: its connection, and key ranges of the same implementation. */
export interface DotliIdb {
  connect: () => Promise<IDBDatabase>;
  /** Read at use, as a context without IndexedDB, such as the build, still loads the stores. */
  keyRange: () => typeof IDBKeyRange;
}

/** The page's own IndexedDB. */
export const pageIdb: DotliIdb = { connect: getDb, keyRange: () => IDBKeyRange };
