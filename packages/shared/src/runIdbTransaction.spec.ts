// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import { waitForIdbRequest } from './waitForIdbRequest.js';
import { runIdbTransaction } from './runIdbTransaction.js';
import { openIdb } from './openIdb.js';

const STORE = 'items';
let db: IDBDatabase;

beforeEach(async () => {
  db = await openIdb({
    factory: new IDBFactory(),
    name: 'test',
    version: 1,
    upgrade: created => {
      created.createObjectStore(STORE, { keyPath: 'id' });
    },
  });
});

function readItem(id: string): Promise<unknown> {
  return waitForIdbRequest(db.transaction(STORE).objectStore(STORE).get(id));
}

describe('runIdbTransaction', () => {
  it('As a store, I write in a transaction and the write has committed when it resolves', async () => {
    // Given
    const item = { id: 'a', value: 1 };

    // When
    await runIdbTransaction({
      db,
      stores: STORE,
      mode: 'readwrite',
      body: transaction => {
        transaction.objectStore(STORE).put(item);
      },
    });

    // Then
    expect(await readItem('a')).toEqual(item);
  });

  it('As a store, I write in a transaction whose request fails part way and get its error with nothing kept', async () => {
    // Given an item a second add collides with
    await runIdbTransaction({
      db,
      stores: STORE,
      mode: 'readwrite',
      body: transaction => {
        transaction.objectStore(STORE).add({ id: 'a' });
      },
    });

    // When
    const failed = runIdbTransaction({
      db,
      stores: STORE,
      mode: 'readwrite',
      body: transaction => {
        transaction.objectStore(STORE).put({ id: 'b' });
        transaction.objectStore(STORE).add({ id: 'a' });
      },
    });

    // Then
    await expect(failed).rejects.toMatchObject({ name: 'ConstraintError' });
    expect(await readItem('b')).toBeUndefined();
  });

  it('As a store, I run a transaction that aborts with requests pending and get its cause, not their AbortError', async () => {
    // Given an item a second add collides with
    await runIdbTransaction({
      db,
      stores: STORE,
      mode: 'readwrite',
      body: transaction => {
        transaction.objectStore(STORE).add({ id: 'a' });
      },
    });

    // When the collision aborts the transaction without its error reaching the transaction, as an abort from outside
    // does, while a later request is still pending
    const aborted = runIdbTransaction({
      db,
      stores: STORE,
      mode: 'readwrite',
      body: transaction => {
        const store = transaction.objectStore(STORE);
        store.add({ id: 'a' }).onerror = event => {
          event.stopPropagation();
        };
        store.put({ id: 'b' });
      },
    });

    // Then
    await expect(aborted).rejects.toMatchObject({ name: 'ConstraintError' });
    expect(await readItem('b')).toBeUndefined();
  });

  it('As a store, I abort a transaction on purpose and it rejects naming the database and store', async () => {
    // When
    const aborted = runIdbTransaction({
      db,
      stores: STORE,
      mode: 'readwrite',
      body: transaction => {
        transaction.abort();
      },
    });

    // Then
    await expect(aborted).rejects.toThrow('IndexedDB transaction aborted on items in test DB');
  });

  it('As a store, I write in a body that then throws and get its error with nothing committed', async () => {
    // Given
    const thrown = new Error('body failed');

    // When
    const failed = runIdbTransaction({
      db,
      stores: STORE,
      mode: 'readwrite',
      body: transaction => {
        transaction.objectStore(STORE).put({ id: 'b' });
        throw thrown;
      },
    });

    // Then
    await expect(failed).rejects.toBe(thrown);
    expect(await readItem('b')).toBeUndefined();
  });

  it('As a store, I open a transaction on a closed connection and it rejects rather than throwing', async () => {
    // Given
    db.close();

    // When
    const closed = runIdbTransaction({ db, stores: STORE, mode: 'readonly', body: () => undefined });

    // Then
    await expect(closed).rejects.toMatchObject({ name: 'InvalidStateError' });
  });
});
