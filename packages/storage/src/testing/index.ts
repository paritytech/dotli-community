// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Fakes other packages' tests use. Shipped code cannot import this entry.

import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { createPageDb, type DotliIdb } from '../db.js';

export interface MemoryIdb extends DotliIdb {
  /** The factory behind `connect`, for a test that opens the database itself. */
  factory: IDBFactory;
}

/** A fresh in-memory IndexedDB, holding nothing, that a store reads and writes in place of the page's own. */
export function memoryIdb(): MemoryIdb {
  const factory = new IDBFactory();
  return {
    factory,
    connect: createPageDb({ factory: () => factory, slot: undefined }),
    keyRange: () => IDBKeyRange,
  };
}
