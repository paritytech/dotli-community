// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The "dotli", "dotli-wallet" and "dotli-site-grants" IndexedDB connections, each opened on first use.

import { openIdb } from '@dotli/shared';
import { createDbConnection } from './createDbConnection.js';
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

/** The IndexedDB a store reads and writes: its connection, and key ranges of the same implementation. */
export type DotliIdb = {
  /** Resolves the open connection, opening it on first use. Rejects when the open fails. */
  connect: () => Promise<IDBDatabase>;
  /** Read at use, as a context without IndexedDB, such as the build, still loads the stores. */
  keyRange: () => typeof IDBKeyRange;
};

/**
 * The page's one connection. `indexedDB` is read at each open, as a context without it, such as the build, still
 * loads this module.
 */
const getDb = createDbConnection({
  open: () => openIdb({ factory: indexedDB, name: DB_NAME, version: DB_VERSION, upgrade: upgradeDotliDb }),
});

/** The page's own IndexedDB. */
export const pageIdb: DotliIdb = { connect: getDb, keyRange: () => IDBKeyRange };

const getWalletDb = createDbConnection({
  open: () =>
    openIdb({ factory: indexedDB, name: WALLET_DB_NAME, version: WALLET_DB_VERSION, upgrade: upgradeWalletDb }),
});

/** The frame's wallet database, apart from the page's so no cleanup of that one can reach it. */
export const walletIdb: DotliIdb = { connect: getWalletDb, keyRange: () => IDBKeyRange };

const getSiteGrantsDb = createDbConnection({
  open: () =>
    openIdb({
      factory: indexedDB,
      name: SITE_GRANTS_DB_NAME,
      version: SITE_GRANTS_DB_VERSION,
      upgrade: upgradeSiteGrantsDb,
    }),
});

/** The session windows' grants database, apart from the page's so no cleanup of that one can reach it. */
export const siteGrantsIdb: DotliIdb = { connect: getSiteGrantsDb, keyRange: () => IDBKeyRange };
