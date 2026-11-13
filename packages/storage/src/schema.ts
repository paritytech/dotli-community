// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The "dotli" database's one schema, and the frame's wallet and the session windows' grants databases.

export const DB_NAME = 'dotli';
export const DB_VERSION = 6;

export const CID_STORE = 'cids';
export const NOTIFICATION_STORE = 'scheduled_notifications';
export const NOTIFICATION_BY_PRODUCT_ID = 'byProductId';
export const NOTIFICATION_BY_SCHEDULED_AT = 'byScheduledAt';
export const NOTIFICATION_COUNTER_STORE = 'notification_counters';
export const CHAT_ROOM_STORE = 'chat_rooms';
export const CHAT_MESSAGE_STORE = 'chat_messages';
export const CHAT_MESSAGE_BY_ROOM = 'byRoom';
export const CHAT_BOT_STORE = 'chat_bots';
export const BLOCK_STORE = 'blocks';
export const BLOCK_META_STORE = 'block_meta';
export const BLOCK_META_BY_LAST_USED = 'byLastUsed';

/** Creates the stores and indexes an older version lacks. */
export function upgradeDotliDb(db: IDBDatabase): void {
  if (!db.objectStoreNames.contains(CID_STORE)) {
    db.createObjectStore(CID_STORE, { keyPath: 'label' });
  }
  // v2: scheduled notifications + per-product id counters.
  if (!db.objectStoreNames.contains(NOTIFICATION_STORE)) {
    const store = db.createObjectStore(NOTIFICATION_STORE, {
      keyPath: 'hostId',
      autoIncrement: true,
    });
    store.createIndex(NOTIFICATION_BY_PRODUCT_ID, 'productId', { unique: false });
    store.createIndex(NOTIFICATION_BY_SCHEDULED_AT, 'scheduledAt', { unique: false });
  }
  if (!db.objectStoreNames.contains(NOTIFICATION_COUNTER_STORE)) {
    db.createObjectStore(NOTIFICATION_COUNTER_STORE, { keyPath: 'productId' });
  }
  // v3: product chat rooms and messages.
  if (!db.objectStoreNames.contains(CHAT_ROOM_STORE)) {
    db.createObjectStore(CHAT_ROOM_STORE, {
      keyPath: ['productId', 'roomId'],
    });
  }
  if (!db.objectStoreNames.contains(CHAT_MESSAGE_STORE)) {
    const store = db.createObjectStore(CHAT_MESSAGE_STORE, {
      keyPath: 'seq',
      autoIncrement: true,
    });
    store.createIndex(CHAT_MESSAGE_BY_ROOM, ['productId', 'roomId'], {
      unique: false,
    });
  }
  // v4: product chat bot identities.
  if (!db.objectStoreNames.contains(CHAT_BOT_STORE)) {
    db.createObjectStore(CHAT_BOT_STORE, {
      keyPath: ['productId', 'botId'],
    });
  }
  // v5: relayed content blocks, with sizes and last use apart so pruning never loads the bytes.
  if (!db.objectStoreNames.contains(BLOCK_STORE)) {
    db.createObjectStore(BLOCK_STORE, { keyPath: 'cid' });
  }
  if (!db.objectStoreNames.contains(BLOCK_META_STORE)) {
    const store = db.createObjectStore(BLOCK_META_STORE, { keyPath: 'cid' });
    store.createIndex(BLOCK_META_BY_LAST_USED, 'lastUsed', { unique: false });
  }
}

/** The frame's own database, so cleanups of the shared origin's other databases never touch the wallet. */
export const WALLET_DB_NAME = 'dotli-wallet';
export const WALLET_DB_VERSION = 1;
export const WALLET_STORE = 'local_wallet';

/** The local wallet, one encrypted record. */
export function upgradeWalletDb(db: IDBDatabase): void {
  if (!db.objectStoreNames.contains(WALLET_STORE)) {
    db.createObjectStore(WALLET_STORE, { keyPath: 'id' });
  }
}

/** The session windows' own database, apart from the page's so the landing page's wipe of its origin keeps it. */
export const SITE_GRANTS_DB_NAME = 'dotli-site-grants';
export const SITE_GRANTS_DB_VERSION = 1;
export const SITE_GRANTS_STORE = 'grants';

/** The sites a user signed in to, one record per site token. */
export function upgradeSiteGrantsDb(db: IDBDatabase): void {
  if (!db.objectStoreNames.contains(SITE_GRANTS_STORE)) {
    db.createObjectStore(SITE_GRANTS_STORE, { keyPath: 'token' });
  }
}
