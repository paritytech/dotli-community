// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Fakes other packages' tests use. Shipped code cannot import this entry.

import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { createDbConnection, type DotliIdb } from '../db.js';
import { openIdb } from '@dotli/shared';
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
} from '../schema.js';

export type MemoryIdb = {
  /** The factory behind `connect`, for a test that opens the database itself. */
  factory: IDBFactory;
} & DotliIdb;

export type MemoryIdbOptions = {
  /** Sees each transaction as it opens, before its first request, so a test can watch its commit or make it fail. */
  onTransaction?: (tx: IDBTransaction) => void;
};

/** A transaction on a closed connection throws as a browser words it, which production takes as expected. */
function behaveLikeBrowserOnClose(db: IDBDatabase): IDBDatabase {
  const transaction = db.transaction.bind(db);
  const close = db.close.bind(db);
  let closed = false;
  db.close = () => {
    closed = true;
    close();
  };
  db.transaction = ((...args: Parameters<IDBDatabase['transaction']>) => {
    if (closed) {
      throw new DOMException('The database connection is closing.', 'InvalidStateError');
    }
    return transaction(...args);
  }) as IDBDatabase['transaction'];
  return db;
}

function observeTransactions(db: IDBDatabase, onTransaction: (tx: IDBTransaction) => void): IDBDatabase {
  const transaction = db.transaction.bind(db);
  db.transaction = ((...args: Parameters<IDBDatabase['transaction']>) => {
    const tx = transaction(...args);
    onTransaction(tx);
    return tx;
  }) as IDBDatabase['transaction'];
  return db;
}

function memoryIdbOf(
  open: (factory: IDBFactory) => Promise<IDBDatabase>,
  { onTransaction }: MemoryIdbOptions,
): MemoryIdb {
  const factory = new IDBFactory();
  return {
    factory,
    connect: createDbConnection(async () => {
      const db = behaveLikeBrowserOnClose(await open(factory));
      return onTransaction === undefined ? db : observeTransactions(db, onTransaction);
    }),
    keyRange: () => IDBKeyRange,
  };
}

/** A fresh in-memory IndexedDB, holding nothing, that a store reads and writes in place of the page's own. */
export function memoryIdb(options: MemoryIdbOptions = {}): MemoryIdb {
  return memoryIdbOf(factory => openIdb(factory, DB_NAME, DB_VERSION, upgradeDotliDb), options);
}

/** A fresh in-memory wallet database, in place of the frame's own. */
export function memoryWalletIdb(options: MemoryIdbOptions = {}): MemoryIdb {
  return memoryIdbOf(factory => openIdb(factory, WALLET_DB_NAME, WALLET_DB_VERSION, upgradeWalletDb), options);
}

/** A fresh in-memory site grants database, in place of the session windows' own. */
export function memorySiteGrantsIdb(options: MemoryIdbOptions = {}): MemoryIdb {
  return memoryIdbOf(
    factory => openIdb(factory, SITE_GRANTS_DB_NAME, SITE_GRANTS_DB_VERSION, upgradeSiteGrantsDb),
    options,
  );
}
