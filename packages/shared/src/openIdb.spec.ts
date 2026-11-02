// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { IdbOpenBlockedError } from './idbOpenBlockedError.js';
import { openIdb } from './openIdb.js';

const STORE = 'items';

describe('openIdb', () => {
  it('As a store, I open a database another tab blocks and leave no stray connection when the open succeeds late', async () => {
    // Given an open blocked by an older tab, which then closes so the open goes through unowned
    const factory = new IDBFactory();
    const olderTab = await openIdb({
      factory,
      name: 'late',
      version: 1,
      upgrade: created => {
        created.createObjectStore(STORE);
      },
    });
    await expect(
      openIdb({
        factory,
        name: 'late',
        version: 2,
        upgrade: created => {
          created.createObjectStore('more');
        },
      }),
    ).rejects.toThrow('Failed to open late DB: blocked by another tab');
    olderTab.close();

    // When another tab upgrades the schema further
    const upgrade = await new Promise<'blocked' | 'upgraded'>(resolve => {
      const request = factory.open('late', 3);
      request.onblocked = () => {
        resolve('blocked');
      };
      request.onsuccess = () => {
        request.result.close();
        resolve('upgraded');
      };
    });

    // Then no leftover connection holds it up
    expect(upgrade).toBe('upgraded');
  });

  it("As a caller blocked by another tab, I get IdbOpenBlockedError with the database's name", async () => {
    // Given an older tab that holds the database open at version 1
    const factory = new IDBFactory();
    const olderTab = await openIdb({
      factory,
      name: 'held',
      version: 1,
      upgrade: created => {
        created.createObjectStore(STORE);
      },
    });

    // When this tab opens version 2
    const failure = await openIdb({ factory, name: 'held', version: 2, upgrade: () => {} }).catch(
      (error: unknown) => error,
    );
    olderTab.close();

    // Then it fails with the typed error naming the database
    expect(failure).toBeInstanceOf(IdbOpenBlockedError);
    expect(failure).toMatchObject({
      name: 'IdbOpenBlockedError',
      databaseName: 'held',
      message: 'Failed to open held DB: blocked by another tab',
    });
  });
});
