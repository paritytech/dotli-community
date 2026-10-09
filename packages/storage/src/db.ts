// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The one "dotli" IndexedDB connection, pre-opened during HTML parse by an inline script (`window.__dotliDb`).

import { log } from '@dotli/shared';
import { captureException, recordExpected } from '@dotli/metrics';

declare global {
  interface Window {
    __dotliDb?: Promise<IDBDatabase>;
  }
}

const DB_NAME = 'dotli';
const DB_VERSION = 5;

const BLOCKED_MESSAGE = 'Failed to open dotli DB: blocked by another tab';

let dbPromise: Promise<IDBDatabase> | null = null;

// Bumped on every new handle, so a late `onclose` from an old handle cannot drop a newer one.
let dbGeneration = 0;

function openFresh(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('cids')) {
        db.createObjectStore('cids', { keyPath: 'label' });
      }
      if (!db.objectStoreNames.contains('chains')) {
        db.createObjectStore('chains', { keyPath: 'chain' });
      }
      // v2: scheduled notifications + per-product id counters.
      if (!db.objectStoreNames.contains('scheduled_notifications')) {
        const store = db.createObjectStore('scheduled_notifications', {
          keyPath: 'hostId',
          autoIncrement: true,
        });
        store.createIndex('byProductId', 'productId', { unique: false });
        store.createIndex('byScheduledAt', 'scheduledAt', { unique: false });
      }
      if (!db.objectStoreNames.contains('notification_counters')) {
        // Value: `{ productId, next }`.
        db.createObjectStore('notification_counters', { keyPath: 'productId' });
      }
      // v3: product chat rooms and messages.
      if (!db.objectStoreNames.contains('chat_rooms')) {
        db.createObjectStore('chat_rooms', {
          keyPath: ['productId', 'roomId'],
        });
      }
      if (!db.objectStoreNames.contains('chat_messages')) {
        const store = db.createObjectStore('chat_messages', {
          keyPath: 'seq',
          autoIncrement: true,
        });
        store.createIndex('byRoom', ['productId', 'roomId'], {
          unique: false,
        });
      }
      // v4: product chat bot identities.
      if (!db.objectStoreNames.contains('chat_bots')) {
        db.createObjectStore('chat_bots', {
          keyPath: ['productId', 'botId'],
        });
      }
      // v5: relayed content blocks, with sizes and last use apart so pruning never loads the bytes.
      if (!db.objectStoreNames.contains('blocks')) {
        db.createObjectStore('blocks', { keyPath: 'cid' });
      }
      if (!db.objectStoreNames.contains('block_meta')) {
        const store = db.createObjectStore('block_meta', { keyPath: 'cid' });
        store.createIndex('byLastUsed', 'lastUsed', { unique: false });
      }
    };
    req.onsuccess = () => {
      resolve(req.result);
    };
    req.onerror = () => {
      const cause = req.error;
      reject(new Error(`Failed to open dotli DB: ${cause?.name ?? 'unknown'}`, cause ? { cause } : undefined));
    };
    // A tab on an older schema blocks the upgrade, and blocked fires neither onsuccess nor onerror.
    req.onblocked = () => {
      reject(new Error(BLOCKED_MESSAGE));
    };
  });
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

/** Reuses the pre-opened handle once. A rejected pre-open is reported before the fresh open. */
export function getDb(): Promise<IDBDatabase> {
  if (dbPromise !== null) {
    return dbPromise;
  }

  const preOpened = typeof window !== 'undefined' ? window.__dotliDb : undefined;
  if (preOpened !== undefined) {
    // One use only, so a reopen after close gets a new handle and a rejected pre-open is reported once.
    delete window.__dotliDb;
    dbPromise = preOpened.catch((err: unknown) => {
      if (isExpectedDbError(err)) {
        recordExpected(err, { flow: 'storage', step: 'db_open' });
      } else {
        log.error('[dot.li db] Pre-opened DB handle rejected; falling back to fresh open:', err);
        captureException(err, { flow: 'storage', step: 'db_open', tags: { kind: 'db_pre_opened_rejected' } });
      }
      return openFresh();
    });
  } else {
    dbPromise = openFresh();
  }

  const thisGeneration = ++dbGeneration;

  void dbPromise
    .then(db => {
      db.onclose = () => {
        if (dbGeneration === thisGeneration) {
          dbPromise = null;
        }
      };
      // Another tab is upgrading the schema. Close so it is not blocked.
      db.onversionchange = () => {
        db.close();
        if (dbGeneration === thisGeneration) {
          dbPromise = null;
        }
      };
    })
    .catch(() => {
      /* fire-and-forget */
    });

  return dbPromise;
}
