// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The "dotli" database's one schema, and the frame's wallet and the session windows' grants databases.

export const DB_NAME = 'dotli';
export const DB_VERSION = 9;

export const CID_STORE = 'cids';
export const NAME_LIST_STORE = 'name_lists';
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
export const FETCH_GRANT_STORE = 'fetch_grants';
export const STACK_STORE = 'stacks';
export const LIGHT_SPEC_STORE = 'light_specs';

type StoreSchema = {
  name: string;
  key: IDBObjectStoreParameters;
  /** Created with the store, never on a store an older version made. */
  indexes?: readonly { name: string; keyPath: string | string[] }[];
};

// One row per store, so a version that adds stores adds rows and no branch.
const DOTLI_STORES: readonly StoreSchema[] = [
  { name: CID_STORE, key: { keyPath: 'label' } },
  // v2: scheduled notifications + per-product id counters.
  {
    name: NOTIFICATION_STORE,
    key: { keyPath: 'hostId', autoIncrement: true },
    indexes: [
      { name: NOTIFICATION_BY_PRODUCT_ID, keyPath: 'productId' },
      { name: NOTIFICATION_BY_SCHEDULED_AT, keyPath: 'scheduledAt' },
    ],
  },
  { name: NOTIFICATION_COUNTER_STORE, key: { keyPath: 'productId' } },
  // v3: product chat rooms and messages.
  { name: CHAT_ROOM_STORE, key: { keyPath: ['productId', 'roomId'] } },
  {
    name: CHAT_MESSAGE_STORE,
    key: { keyPath: 'seq', autoIncrement: true },
    indexes: [{ name: CHAT_MESSAGE_BY_ROOM, keyPath: ['productId', 'roomId'] }],
  },
  // v4: product chat bot identities.
  { name: CHAT_BOT_STORE, key: { keyPath: ['productId', 'botId'] } },
  // v5: relayed content blocks, with sizes and last use apart so pruning never loads the bytes.
  { name: BLOCK_STORE, key: { keyPath: 'cid' } },
  {
    name: BLOCK_META_STORE,
    key: { keyPath: 'cid' },
    indexes: [{ name: BLOCK_META_BY_LAST_USED, keyPath: 'lastUsed' }],
  },
  // v7: the landing page's dotNS name lists.
  { name: NAME_LIST_STORE, key: { keyPath: 'network' } },
  // v8: the user's lasting answers to a product fetching a host.
  { name: FETCH_GRANT_STORE, key: { keyPath: ['label', 'host'] } },
  // v9: each network's stored stack and the light specs the light client accepted.
  { name: STACK_STORE, key: { keyPath: 'network' } },
  { name: LIGHT_SPEC_STORE, key: { keyPath: 'network' } },
];

/** Creates the stores and indexes an older version lacks. */
export function upgradeDotliDb(db: IDBDatabase): void {
  for (const { name, key, indexes = [] } of DOTLI_STORES) {
    if (db.objectStoreNames.contains(name)) {
      continue;
    }
    const store = db.createObjectStore(name, key);
    for (const index of indexes) {
      store.createIndex(index.name, index.keyPath, { unique: false });
    }
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
