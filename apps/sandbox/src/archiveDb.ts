// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The archive the worker keeps in IndexedDB, so it outlives the worker. The browser stops an idle worker after about
// 30s.

/// <reference lib="webworker" />

import { openIdb, runIdbTransaction, waitForIdbRequest } from '@dotli/shared';

/** Where each file sits in the packed buffer: its path, offset and length. */
export type ArchiveIndex = { p: string; o: number; l: number }[];

type PersistedArchive = {
  packed: ArrayBuffer;
  index: ArchiveIndex;
  /** Absent in an archive a worker from the previous release kept. */
  directory?: string;
};

const ARCHIVE_DB_NAME = 'dotli-app-sw';
const ARCHIVE_STORE = 'archive';
const CURRENT_ARCHIVE_KEY = 'current';

/** Replaces the kept archive with `archive`. Rejects when the database cannot open or the write fails. */
export async function persistArchive(indexedDB: IDBFactory, archive: PersistedArchive): Promise<void> {
  const db = await openArchiveDb(indexedDB);
  try {
    await runIdbTransaction({
      db,
      stores: ARCHIVE_STORE,
      mode: 'readwrite',
      body: transaction => {
        transaction.objectStore(ARCHIVE_STORE).put(archive, CURRENT_ARCHIVE_KEY);
      },
    });
  } finally {
    db.close();
  }
}

/** The kept archive, or `null` when none was kept. Rejects when the database cannot open or the read fails. */
export async function loadPersistedArchive(indexedDB: IDBFactory): Promise<PersistedArchive | null> {
  const db = await openArchiveDb(indexedDB);
  try {
    // This module is the only writer of the store, so the record has the shape it wrote.
    const stored = (await waitForIdbRequest(
      db.transaction(ARCHIVE_STORE, 'readonly').objectStore(ARCHIVE_STORE).get(CURRENT_ARCHIVE_KEY),
    )) as PersistedArchive | undefined;
    return stored ?? null;
  } finally {
    db.close();
  }
}

function openArchiveDb(indexedDB: IDBFactory): Promise<IDBDatabase> {
  return openIdb({
    factory: indexedDB,
    name: ARCHIVE_DB_NAME,
    version: 1,
    upgrade: db => {
      db.createObjectStore(ARCHIVE_STORE);
    },
  });
}
