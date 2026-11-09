// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';

import { openIdb, runIdbTransaction } from '@dotli/shared';

import { loadPersistedArchives, persistPageArchive, persistWorkerPage, type PersistedArchive } from './archiveDb.js';

function createArchive(byte: number): PersistedArchive {
  return { packed: new Uint8Array([byte]).buffer, index: [{ p: 'index.html', o: 0, l: 1 }], directory: '/' };
}

type PutRecordParams = { version: number; key: string; value: unknown };

/** Opens the store at `version` and puts a record the store's writer never would, as an earlier release or damage leaves it. */
async function putRecord(indexedDB: IDBFactory, { version, key, value }: PutRecordParams): Promise<void> {
  const db = await openIdb({
    factory: indexedDB,
    name: 'dotli-app-sw',
    version,
    upgrade: next => {
      next.createObjectStore('archive');
    },
  });
  try {
    await runIdbTransaction({
      db,
      stores: 'archive',
      mode: 'readwrite',
      body: transaction => {
        transaction.objectStore('archive').put(value, key);
      },
    });
  } finally {
    db.close();
  }
}

/** Every key the store holds, as the current schema keeps it. */
async function readKeys(indexedDB: IDBFactory): Promise<IDBValidKey[]> {
  const db = await openIdb({ factory: indexedDB, name: 'dotli-app-sw', version: 2, upgrade: () => undefined });
  let keys: IDBValidKey[] = [];
  try {
    await runIdbTransaction({
      db,
      stores: 'archive',
      mode: 'readonly',
      body: transaction => {
        const request = transaction.objectStore('archive').getAllKeys();
        request.onsuccess = () => {
          keys = request.result;
        };
      },
    });
  } finally {
    db.close();
  }
  return keys;
}

const pageAOnly = { pages: new Map([['page-a', createArchive(1)]]), workerPages: new Map(), newest: 'page-a' };

describe('archive store', () => {
  it("As a worker, I keep two pages' archives and read both back with the newest named", async () => {
    // Given a store that kept page-a's archive while both pages are open
    const indexedDB = new IDBFactory();
    const live = new Set(['page-a', 'page-b']);
    await persistPageArchive(indexedDB, { clientId: 'page-a', archive: createArchive(1), liveClientIds: live });

    // When page-b's archive is kept after it
    await persistPageArchive(indexedDB, { clientId: 'page-b', archive: createArchive(2), liveClientIds: live });

    // Then both read back under their ids, and page-b is the newest
    await expect(loadPersistedArchives(indexedDB)).resolves.toEqual({
      pages: new Map([
        ['page-a', createArchive(1)],
        ['page-b', createArchive(2)],
      ]),
      workerPages: new Map(),
      newest: 'page-b',
    });
  });

  it("As a worker, I keep a page's archive and drop those of pages that are gone", async () => {
    // Given a store that kept page-a's archive
    const indexedDB = new IDBFactory();
    await persistPageArchive(indexedDB, {
      clientId: 'page-a',
      archive: createArchive(1),
      liveClientIds: new Set(['page-a']),
    });

    // When page-b's archive is kept once page-a has closed
    await persistPageArchive(indexedDB, {
      clientId: 'page-b',
      archive: createArchive(2),
      liveClientIds: new Set(['page-b']),
    });

    // Then only page-b's archive reads back
    const persisted = await loadPersistedArchives(indexedDB);
    expect([...persisted.pages.keys()]).toEqual(['page-b']);
  });

  it('As a worker, I keep the page a worker belongs to and drop it once that worker is gone', async () => {
    // Given a store that kept page-a's archive and the worker page-a started
    const indexedDB = new IDBFactory();
    await persistPageArchive(indexedDB, {
      clientId: 'page-a',
      archive: createArchive(1),
      liveClientIds: new Set(['page-a', 'worker-1']),
    });
    await persistWorkerPage(indexedDB, { workerId: 'worker-1', pageId: 'page-a' });
    const kept = await loadPersistedArchives(indexedDB);

    // When page-a hands its archive again once the worker has stopped
    await persistPageArchive(indexedDB, {
      clientId: 'page-a',
      archive: createArchive(2),
      liveClientIds: new Set(['page-a']),
    });

    // Then the worker's page read back while it ran, and is gone after
    const persisted = await loadPersistedArchives(indexedDB);
    expect(kept.workerPages).toEqual(new Map([['worker-1', 'page-a']]));
    expect(persisted.workerPages).toEqual(new Map());
  });

  it('As a worker over an empty store, I read back nothing', async () => {
    // Given a store nothing was kept in
    const indexedDB = new IDBFactory();

    // When the store is read back
    const persisted = await loadPersistedArchives(indexedDB);

    // Then it holds no page, no worker and no newest page
    expect(persisted).toEqual({ pages: new Map(), workerPages: new Map(), newest: null });
  });

  it('As a worker over a store an earlier release kept, I read back nothing', async () => {
    // Given a store a worker of an earlier release kept its one archive in
    const indexedDB = new IDBFactory();
    await putRecord(indexedDB, { version: 1, key: 'current', value: createArchive(1) });

    // When the store is read back
    const persisted = await loadPersistedArchives(indexedDB);

    // Then it holds no page, no worker and no newest page
    expect(persisted).toEqual({ pages: new Map(), workerPages: new Map(), newest: null });
  });

  it('As a worker over a store an earlier release kept, I start the store over when I keep a page archive', async () => {
    // Given a store a worker of an earlier release kept its one archive in
    const indexedDB = new IDBFactory();
    await putRecord(indexedDB, { version: 1, key: 'current', value: createArchive(1) });

    // When page-a's archive is kept
    await persistPageArchive(indexedDB, {
      clientId: 'page-a',
      archive: createArchive(2),
      liveClientIds: new Set(['page-a']),
    });

    // Then the earlier release's archive is gone and only this release's records remain
    expect(await readKeys(indexedDB)).toEqual(['client:page-a', 'newest']);
  });

  it.each([
    {
      record: 'a page archive with no directory',
      key: 'client:page-b',
      value: { packed: new ArrayBuffer(1), index: [] },
      expected: pageAOnly,
    },
    {
      record: 'a page archive whose index holds a bad entry',
      key: 'client:page-b',
      value: { packed: new ArrayBuffer(1), index: [{ p: 'index.html' }], directory: '/' },
      expected: pageAOnly,
    },
    {
      record: 'a worker page that is not an id',
      key: 'worker:worker-1',
      value: 7,
      expected: pageAOnly,
    },
    {
      record: 'a newest page that is not an id',
      key: 'newest',
      value: { id: 'page-a' },
      expected: { ...pageAOnly, newest: null },
    },
  ])(
    'As a worker over a store holding $record, I skip that record and read back the rest',
    async ({ key, value, expected }) => {
      // Given a store that kept page-a's archive and then holds a record of the wrong shape
      const indexedDB = new IDBFactory();
      await persistPageArchive(indexedDB, {
        clientId: 'page-a',
        archive: createArchive(1),
        liveClientIds: new Set(['page-a']),
      });
      await putRecord(indexedDB, { version: 2, key, value });

      // When the store is read back
      const persisted = await loadPersistedArchives(indexedDB);

      // Then the damaged record is left out and every other record reads back
      expect(persisted).toEqual(expected);
    },
  );
});
