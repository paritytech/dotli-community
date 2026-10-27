// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { openIdb } from '@dotli/shared';
import { DB_NAME, DB_VERSION, upgradeDotliDb } from '../schema.js';
import { createMemoryIdbOf, type MemoryIdb, type MemoryIdbParams } from './createMemoryIdbOf.js';

/** A fresh in-memory IndexedDB, holding nothing, that a store reads and writes in place of the page's own. */
export function createMemoryIdb(params: MemoryIdbParams = {}): MemoryIdb {
  return createMemoryIdbOf({
    open: factory => openIdb({ factory, name: DB_NAME, version: DB_VERSION, upgrade: upgradeDotliDb }),
    ...params,
  });
}
