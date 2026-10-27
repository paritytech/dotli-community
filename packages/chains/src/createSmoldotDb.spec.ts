// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, onTestFinished, vi } from 'vitest';
import { must } from '@dotli/shared/testing';
import { createSmoldotDb } from './createSmoldotDb.js';

const GENESIS = '0x374057be67b355151f271ff70c3db98308c62c8adc48dc6724b6a009a1a014fd';
// Over the 100_000 byte floor, so `save` gets as far as opening the database.
const BLOB = 'x'.repeat(200_000);

/** Hold the database open at version 1, as a tab on the previous build does, which blocks the upgrade. */
function holdDatabaseAtV1(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open('dotli-smoldot-db', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('chain-db');
    };
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error('open failed'));
    };
  });
}

describe('Light-client database', () => {
  it('As a user with a tab holding database v1, I save from a new tab and it fails as blocked instead of hanging until the old tab closes', async () => {
    // Given
    const factory = new IDBFactory();
    const v1Tab = await holdDatabaseAtV1(factory);
    const db = must(createSmoldotDb({ factory }), 'database');
    onTestFinished(() => {
      v1Tab.close();
    });
    // The timeout never runs, so a save that waited it out would never settle and fail by the test's own timeout.
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    onTestFinished(() => {
      vi.useRealTimers();
    });

    // When
    const save = db.save(GENESIS, BLOB);

    // Then
    await expect(save).rejects.toThrow(/blocked/);
  });

  it('As a user of a browser without IndexedDB, I get no database and my light client starts cold rather than failing', () => {
    // When
    const db = createSmoldotDb({ factory: null });

    // Then
    expect(db).toBeNull();
  });
});
