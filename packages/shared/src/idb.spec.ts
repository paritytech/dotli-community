// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import { deleteIdb, idbRequest, idbTransaction, openIdb } from './idb.js';

const STORE = 'items';
let db: IDBDatabase;

beforeEach(async () => {
  db = await openIdb(new IDBFactory(), 'test', 1, created => {
    created.createObjectStore(STORE, { keyPath: 'id' });
  });
});

function readItem(id: string): Promise<unknown> {
  return idbRequest(db.transaction(STORE).objectStore(STORE).get(id));
}

describe('idbTransaction', () => {
  it('As a store, I write in a transaction and the write has committed when it resolves', async () => {
    // Given
    const item = { id: 'a', value: 1 };

    // When
    await idbTransaction(db, STORE, 'readwrite', tx => {
      tx.objectStore(STORE).put(item);
    });

    // Then
    expect(await readItem('a')).toEqual(item);
  });

  it('As a store, I write in a transaction whose request fails part way and get its error with nothing kept', async () => {
    // Given an item a second add collides with
    await idbTransaction(db, STORE, 'readwrite', tx => {
      tx.objectStore(STORE).add({ id: 'a' });
    });

    // When
    const failed = idbTransaction(db, STORE, 'readwrite', tx => {
      tx.objectStore(STORE).put({ id: 'b' });
      tx.objectStore(STORE).add({ id: 'a' });
    });

    // Then
    await expect(failed).rejects.toMatchObject({ name: 'ConstraintError' });
    expect(await readItem('b')).toBeUndefined();
  });

  it('As a store, I run a transaction that aborts with requests pending and get its cause, not their AbortError', async () => {
    // Given an item a second add collides with
    await idbTransaction(db, STORE, 'readwrite', tx => {
      tx.objectStore(STORE).add({ id: 'a' });
    });

    // When the collision aborts the transaction without its error reaching the transaction, as an abort from outside
    // does, while a later request is still pending
    const aborted = idbTransaction(db, STORE, 'readwrite', tx => {
      const store = tx.objectStore(STORE);
      store.add({ id: 'a' }).onerror = event => {
        event.stopPropagation();
      };
      store.put({ id: 'b' });
    });

    // Then
    await expect(aborted).rejects.toMatchObject({ name: 'ConstraintError' });
    expect(await readItem('b')).toBeUndefined();
  });

  it('As a store, I abort a transaction on purpose and it rejects', async () => {
    // When
    const aborted = idbTransaction(db, STORE, 'readwrite', tx => {
      tx.abort();
    });

    // Then
    await expect(aborted).rejects.toThrow('IndexedDB transaction aborted');
  });

  it('As a store, I write in a body that then throws and get its error with nothing committed', async () => {
    // Given
    const thrown = new Error('body failed');

    // When
    const failed = idbTransaction(db, STORE, 'readwrite', tx => {
      tx.objectStore(STORE).put({ id: 'b' });
      throw thrown;
    });

    // Then
    await expect(failed).rejects.toBe(thrown);
    expect(await readItem('b')).toBeUndefined();
  });

  it('As a store, I open a transaction on a closed connection and it rejects rather than throwing', async () => {
    // Given
    db.close();

    // When
    const closed = idbTransaction(db, STORE, 'readonly', () => undefined);

    // Then
    await expect(closed).rejects.toMatchObject({ name: 'InvalidStateError' });
  });
});

describe('openIdb', () => {
  it('As a store, I leave no stray connection behind after an open is blocked and succeeds late', async () => {
    // Given an open blocked by an older tab, which then closes so the open goes through unowned
    const factory = new IDBFactory();
    const olderTab = await openIdb(factory, 'late', 1, created => {
      created.createObjectStore(STORE);
    });
    await expect(
      openIdb(factory, 'late', 2, created => {
        created.createObjectStore('more');
      }),
    ).rejects.toThrow('Failed to open late DB: blocked by another tab');
    olderTab.close();

    // When another tab upgrades the schema further
    const upgrade = await new Promise<'blocked' | 'upgraded'>(resolve => {
      const req = factory.open('late', 3);
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

describe('idbRequest', () => {
  it('As a store, I make a request that fails and get its error', async () => {
    // Given
    await idbTransaction(db, STORE, 'readwrite', tx => {
      tx.objectStore(STORE).add({ id: 'a' });
    });

    // When
    const request = idbRequest(db.transaction(STORE, 'readwrite').objectStore(STORE).add({ id: 'a' }));

    // Then
    await expect(request).rejects.toMatchObject({ name: 'ConstraintError' });
  });
});

describe('deleteIdb', () => {
  it('As a purge, I delete a database and it is gone once the delete resolves', async () => {
    // Given
    const factory = new IDBFactory();
    const opened = await openIdb(factory, 'gone', 1, created => {
      created.createObjectStore(STORE);
    });
    opened.close();

    // When
    await deleteIdb(factory, 'gone');

    // Then
    expect((await factory.databases()).map(info => info.name)).not.toContain('gone');
  });

  it('As a page deleting a database another tab holds open, the delete completes once that tab closes it', async () => {
    // Given another tab holding the database open
    const factory = new IDBFactory();
    const otherTab = await openIdb(factory, 'held', 1, created => {
      created.createObjectStore(STORE);
    });

    // When the delete reports blocked and the other tab then closes its connection
    const deleted = deleteIdb(
      {
        deleteDatabase(name) {
          const req = factory.deleteDatabase(name);
          req.addEventListener('blocked', () => {
            otherTab.close();
          });
          return req;
        },
      },
      'held',
    );

    // Then the delete completes
    await deleted;
    expect((await factory.databases()).map(info => info.name)).not.toContain('held');
  });

  it('As a purge, I delete a database another connection never releases and the delete rejects rather than hangs', async () => {
    // Given
    const factory = new IDBFactory();
    await openIdb(factory, 'held', 1, created => {
      created.createObjectStore(STORE);
    });

    // When
    const deleted = deleteIdb(factory, 'held', 20);

    // Then
    await expect(deleted).rejects.toThrow('Failed to delete held DB: still blocked by another connection');
  });
});
