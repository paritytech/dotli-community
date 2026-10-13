// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect } from 'vitest';
import { createSmoldotDb } from './smoldot-db.js';

const GENESIS = '0x374057be67b355151f271ff70c3db98308c62c8adc48dc6724b6a009a1a014fd';
// Over the 100_000 byte floor, so `save` gets as far as opening the database.
const BLOB = 'x'.repeat(200_000);

/** Hold the database open at version 1, as a tab on the previous build does, which blocks the upgrade. */
function holdDatabaseAtV1(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = factory.open('dotli-smoldot-db', 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('chain-db');
    };
    req.onsuccess = () => {
      resolve(req.result);
    };
    req.onerror = () => {
      reject(req.error ?? new Error('open failed'));
    };
  });
}

describe('Light-client database', () => {
  it('As a user with a tab holding database v1, a new tab does not hang waiting for it to close', async () => {
    // Given
    const factory = new IDBFactory();
    const v1Tab = await holdDatabaseAtV1(factory);
    const db = createSmoldotDb(factory);
    expect(db).not.toBeNull();

    try {
      if (db === null) {
        throw new Error('expected a database');
      }
      // When
      const started = Date.now();
      const outcome = await db
        .save(GENESIS, BLOB)
        .then(() => 'resolved')
        .catch((err: unknown) => String(err));
      const elapsed = Date.now() - started;

      // Then
      expect(outcome).toContain('blocked');
      expect(elapsed, 'the new tab should give up straight away, not wait out the timeout').toBeLessThan(1_000);
    } finally {
      v1Tab.close();
    }
  });

  it('As a user of a browser without IndexedDB, my light client starts cold rather than failing', () => {
    // When
    const db = createSmoldotDb(null);

    // Then
    expect(db).toBeNull();
  });
});
