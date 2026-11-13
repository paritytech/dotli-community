// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { waitForIdbRequest } from './waitForIdbRequest.js';
import { runIdbTransaction } from './runIdbTransaction.js';
import { openIdb } from './openIdb.js';

const STORE = 'items';

describe('waitForIdbRequest', () => {
  it('As a store, I make a request that fails and get its error', async () => {
    // Given
    const db = await openIdb({
      factory: new IDBFactory(),
      name: 'test',
      version: 1,
      upgrade: created => {
        created.createObjectStore(STORE, { keyPath: 'id' });
      },
    });
    await runIdbTransaction({
      db,
      stores: STORE,
      mode: 'readwrite',
      body: transaction => {
        transaction.objectStore(STORE).add({ id: 'a' });
      },
    });

    // When
    const request = waitForIdbRequest(db.transaction(STORE, 'readwrite').objectStore(STORE).add({ id: 'a' }));

    // Then
    await expect(request).rejects.toMatchObject({ name: 'ConstraintError' });
  });
});
