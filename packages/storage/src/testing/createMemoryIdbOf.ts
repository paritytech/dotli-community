// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { createDbConnection } from '../createDbConnection.js';
import type { DotliIdb } from '../db.js';

export type MemoryIdb = {
  /** The factory behind `connect`, for a test that opens the database itself. */
  factory: IDBFactory;
} & DotliIdb;

export type MemoryIdbParams = {
  /** Sees each transaction as it opens, before its first request, so a test can watch its commit or make it fail. */
  onTransaction?: (transaction: IDBTransaction) => void;
};

type Params = MemoryIdbParams & {
  /** Opens the database on the fresh in-memory factory. */
  open: (factory: IDBFactory) => Promise<IDBDatabase>;
};

/** A fresh in-memory IndexedDB, holding nothing, opened by `open`. */
export function createMemoryIdbOf({ open, onTransaction }: Params): MemoryIdb {
  const factory = new IDBFactory();
  return {
    factory,
    connect: createDbConnection({
      open: async () => {
        const db = behaveLikeBrowserOnClose(await open(factory));
        return onTransaction === undefined ? db : observeTransactions(db, onTransaction);
      },
    }),
    keyRange: () => IDBKeyRange,
  };
}

/** A transaction on a closed connection throws as a browser words it, which production takes as expected. */
function behaveLikeBrowserOnClose(db: IDBDatabase): IDBDatabase {
  const openTransaction = db.transaction.bind(db);
  const close = db.close.bind(db);
  let closed = false;
  db.close = () => {
    closed = true;
    close();
  };
  // A rest-argument wrapper cannot take the overloaded signature by inference, and it passes every overload through.
  db.transaction = ((...args: Parameters<IDBDatabase['transaction']>) => {
    if (closed) {
      throw new DOMException('The database connection is closing.', 'InvalidStateError');
    }
    return openTransaction(...args);
  }) as IDBDatabase['transaction'];
  return db;
}

function observeTransactions(db: IDBDatabase, onTransaction: (transaction: IDBTransaction) => void): IDBDatabase {
  const openTransaction = db.transaction.bind(db);
  // A rest-argument wrapper cannot take the overloaded signature by inference, and it passes every overload through.
  db.transaction = ((...args: Parameters<IDBDatabase['transaction']>) => {
    const transaction = openTransaction(...args);
    onTransaction(transaction);
    return transaction;
  }) as IDBDatabase['transaction'];
  return db;
}
