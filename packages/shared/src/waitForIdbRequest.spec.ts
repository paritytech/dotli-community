// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { waitForIdbRequest } from './waitForIdbRequest.js';
import { runIdbTransaction } from './runIdbTransaction.js';
import { openIdb } from './openIdb.js';

const STORE = 'items';

type FakeRequest = {
  error: DOMException | null;
  transaction: { db: { name: string } } | null;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
};

function createFailingRequest(transaction: FakeRequest['transaction']): { request: IDBRequest; fail: () => void } {
  const fake: FakeRequest = { error: null, transaction, onsuccess: null, onerror: null };
  return {
    // Only the fields waitForIdbRequest reads exist on the fake, and the browser's request type has many more.
    request: fake as unknown as IDBRequest,
    fail: () => {
      fake.onerror?.();
    },
  };
}

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

  it('As a store, I make a request in a database that fails with no error and the message names the database', async () => {
    // Given
    const { request, fail } = createFailingRequest({ db: { name: 'orders' } });
    const outcome = waitForIdbRequest(request).catch((caught: unknown) => caught);

    // When
    fail();

    // Then
    expect(await outcome).toEqual(new Error('IndexedDB request failed in orders DB'));
  });

  it('As a store, I make a request outside any transaction that fails with no error and keep the plain message', async () => {
    // Given
    const { request, fail } = createFailingRequest(null);
    const outcome = waitForIdbRequest(request).catch((caught: unknown) => caught);

    // When
    fail();

    // Then
    expect(await outcome).toEqual(new Error('IndexedDB request failed'));
  });
});
