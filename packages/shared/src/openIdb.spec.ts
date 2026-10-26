// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
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
});
