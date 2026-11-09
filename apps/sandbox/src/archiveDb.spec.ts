// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';

import { openIdb, runIdbTransaction } from '@dotli/shared';

import { loadPersistedArchives, persistPageArchive, persistWorkerPage, type PersistedArchive } from './archiveDb.js';

function createArchive(byte: number): PersistedArchive {
  return { packed: new Uint8Array([byte]).buffer, index: [{ p: 'index.html', o: 0, l: 1 }], directory: '/' };
}

/** Leaves a database as a worker of an earlier release kept it, one archive under a single key. */
async function keepEarlierReleaseArchive(indexedDB: IDBFactory): Promise<void> {
  const db = await openIdb({
    factory: indexedDB,
    name: 'dotli-app-sw',
    version: 1,
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
        transaction.objectStore('archive').put(createArchive(1), 'current');
      },
    });
  } finally {
    db.close();
  }
}

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
    await keepEarlierReleaseArchive(indexedDB);

    // When the store is read back
    const persisted = await loadPersistedArchives(indexedDB);

    // Then it holds no page, no worker and no newest page
    expect(persisted).toEqual({ pages: new Map(), workerPages: new Map(), newest: null });
  });
});
