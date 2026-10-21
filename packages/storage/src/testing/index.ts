// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Fakes other packages' tests use. Shipped code cannot import this entry.

import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { createDbConnection, type DotliIdb } from '../db.js';
import { openIdb } from '@dotli/shared';
import { DB_NAME, DB_VERSION, upgradeDotliDb } from '../schema.js';

export interface MemoryIdb extends DotliIdb {
  /** The factory behind `connect`, for a test that opens the database itself. */
  factory: IDBFactory;
}

export interface MemoryIdbOptions {
  /** Sees each transaction as it opens, before its first request, so a test can watch its commit or make it fail. */
  onTransaction?: (tx: IDBTransaction) => void;
}

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

/** A fresh in-memory IndexedDB, holding nothing, that a store reads and writes in place of the page's own. */
export function memoryIdb(options: MemoryIdbOptions = {}): MemoryIdb {
  const factory = new IDBFactory();
  const { onTransaction } = options;
  return {
    factory,
    connect: createDbConnection(async () => {
      const db = behaveLikeBrowserOnClose(await openIdb(factory, DB_NAME, DB_VERSION, upgradeDotliDb));
      return onTransaction === undefined ? db : observeTransactions(db, onTransaction);
    }),
    keyRange: () => IDBKeyRange,
  };
}
