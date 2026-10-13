// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The "dotli" database's one schema and its open.

export const DB_NAME = 'dotli';
export const DB_VERSION = 6;

/** Creates the stores and indexes an older version lacks. */
export function upgradeDotliDb(db: IDBDatabase): void {
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
  // v6: the local wallet, one encrypted record.
  if (!db.objectStoreNames.contains('local_wallet')) {
    db.createObjectStore('local_wallet', { keyPath: 'id' });
  }
}

/** Opens the database on `version`, rejecting rather than hanging when an older tab blocks the upgrade. */
export function openDotliDb(
  factory: IDBFactory,
  name: string,
  version: number,
  upgrade: (db: IDBDatabase) => void,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = factory.open(name, version);
    req.onupgradeneeded = () => {
      upgrade(req.result);
    };
    // The caller already got the blocked rejection, so a late success has no owner and must not stay open.
    let abandoned = false;
    req.onsuccess = () => {
      if (abandoned) {
        req.result.close();
        return;
      }
      resolve(req.result);
    };
    req.onerror = () => {
      // Only the cause keeps the DOMException's message for the report.
      const cause = req.error;
      reject(new Error(`Failed to open dotli DB: ${cause?.name ?? 'unknown'}`, cause ? { cause } : undefined));
    };
    // A tab on an older schema blocks the upgrade, and blocked fires neither onsuccess nor onerror.
    req.onblocked = () => {
      abandoned = true;
      reject(new Error('Failed to open dotli DB: blocked by another tab'));
    };
  });
}
