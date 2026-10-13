// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { DB_NAME, DB_VERSION, preOpenDotliDb } from './schema.js';

/** Runs the page's pre-open against `factory`, as its head script does during HTML parse. */
function runPreOpen(factory: IDBFactory): Promise<IDBDatabase> {
  const page: { __dotliDb?: Promise<IDBDatabase> } = {};
  preOpenDotliDb(page, factory);
  if (page.__dotliDb === undefined) {
    throw new Error('the pre-open exposed no database promise');
  }
  return page.__dotliDb;
}

/** A connection on the previous schema that ignores `versionchange`, as a frozen older tab would. */
function openPreviousSchema(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = factory.open(DB_NAME, DB_VERSION - 1);
    req.onsuccess = () => {
      resolve(req.result);
    };
    req.onerror = () => {
      reject(req.error ?? new Error('open failed'));
    };
  });
}

describe('the page IndexedDB pre-open', () => {
  it('As a dotli user, the page pre-open hands the app the database on the current schema', async () => {
    // Given a browser that has never opened the database
    const factory = new IDBFactory();

    // When the page pre-opens it
    const db = await runPreOpen(factory);

    // Then it is on the current version, with the newest store in place
    expect(db.name).toBe(DB_NAME);
    expect(db.version).toBe(DB_VERSION);
    expect([...db.objectStoreNames]).toContain('local_wallet');
    db.close();
  });

  it('As a dotli user, I leave no stray connection behind after the page pre-open is blocked and succeeds late', async () => {
    // Given a pre-open blocked by an older tab, which then closes so the open goes through unowned
    const factory = new IDBFactory();
    const olderTab = await openPreviousSchema(factory);
    await expect(runPreOpen(factory)).rejects.toThrow('blocked by another tab');
    olderTab.close();

    // When another tab upgrades the schema further
    const upgrade = await new Promise<'blocked' | 'upgraded'>(resolve => {
      const req = factory.open(DB_NAME, DB_VERSION + 1);
      req.onblocked = () => {
        resolve('blocked');
      };
      req.onsuccess = () => {
        req.result.close();
        resolve('upgraded');
      };
    });

    // Then no leftover connection holds it up
    expect(upgrade).toBe('upgraded');
  });
});
