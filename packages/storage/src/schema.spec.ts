// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { openIdb } from '@dotli/shared';
import { DB_NAME, DB_VERSION, upgradeDotliDb } from './schema.js';

/** Opens the database on the current schema against `factory`, as the page's first read does. */
function openCurrent(factory: IDBFactory): Promise<IDBDatabase> {
  return openIdb(factory, DB_NAME, DB_VERSION, upgradeDotliDb);
}

describe('the database open', () => {
  it('As a dotli user, opening the database hands the app the current schema', async () => {
    // Given a browser that has never opened the database
    const factory = new IDBFactory();

    // When the page opens it
    const db = await openCurrent(factory);

    // Then it is on the current version, without the wallet, which has its own database
    expect(db.name).toBe(DB_NAME);
    expect(db.version).toBe(DB_VERSION);
    expect([...db.objectStoreNames]).not.toContain('local_wallet');
    db.close();
  });
});
