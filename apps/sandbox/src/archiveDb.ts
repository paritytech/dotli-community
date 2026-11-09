// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The archives the worker keeps in IndexedDB, so they outlive the worker. The browser stops an idle worker after about
// 30s.

/// <reference lib="webworker" />

import { isRecord, openIdb, runIdbTransaction } from '@dotli/shared';

/** Where each file sits in the packed buffer: its path, offset and length. */
export type ArchiveIndex = { p: string; o: number; l: number }[];

/** A page's archive as the store keeps it. */
export type PersistedArchive = { packed: ArrayBuffer; index: ArchiveIndex; directory: string };

/** Everything the store kept, as a restarted worker reads it back. */
export type PersistedArchives = {
  /** Each page's archive, by the id of the page's client. */
  pages: Map<string, PersistedArchive>;
  /** A worker a page started, by the worker client's id, to the id of that page's client. */
  workerPages: Map<string, string>;
  /** The id of the client whose archive was handed last, or `null` when none was. */
  newest: string | null;
};

type PersistPageArchiveParams = {
  clientId: string;
  archive: PersistedArchive;
  /** The clients still open. A record of any other client is dropped. */
  liveClientIds: ReadonlySet<string>;
};

type PersistWorkerPageParams = { workerId: string; pageId: string };

/** A record's key, read back as what the record holds. */
type RecordKey = { kind: 'page'; id: string } | { kind: 'worker'; id: string } | { kind: 'newest' } | { kind: 'other' };

/** A record read back with its value checked against the shape its key names. */
type StoredRecord =
  | { kind: 'page'; id: string; archive: PersistedArchive }
  | { kind: 'worker'; id: string; pageId: string }
  | { kind: 'newest'; id: string }
  | { kind: 'other' };

const ARCHIVE_DB_NAME = 'dotli-app-sw';
const ARCHIVE_DB_VERSION = 2;
const ARCHIVE_STORE = 'archive';
const PAGE_KEY_PREFIX = 'client:';
const WORKER_KEY_PREFIX = 'worker:';
const NEWEST_KEY = 'newest';

/**
 * Keeps a page's archive as the newest, and drops the records of clients that are no longer open. Rejects when the
 * database cannot open or the transaction fails.
 */
export async function persistPageArchive(
  indexedDB: IDBFactory,
  { clientId, archive, liveClientIds }: PersistPageArchiveParams,
): Promise<void> {
  const db = await openArchiveDb(indexedDB);
  try {
    await runIdbTransaction({
      db,
      stores: ARCHIVE_STORE,
      mode: 'readwrite',
      body: transaction => {
        const store = transaction.objectStore(ARCHIVE_STORE);
        store.put(archive, PAGE_KEY_PREFIX + clientId);
        store.put(clientId, NEWEST_KEY);
        const keys = store.getAllKeys();
        keys.onsuccess = () => {
          for (const key of keys.result) {
            if (isRecordOfClosedClient(key, { clientId, liveClientIds })) {
              store.delete(key);
            }
          }
        };
      },
    });
  } finally {
    db.close();
  }
}

/** Keeps the page a worker client belongs to. Rejects when the database cannot open or the transaction fails. */
export async function persistWorkerPage(
  indexedDB: IDBFactory,
  { workerId, pageId }: PersistWorkerPageParams,
): Promise<void> {
  const db = await openArchiveDb(indexedDB);
  try {
    await runIdbTransaction({
      db,
      stores: ARCHIVE_STORE,
      mode: 'readwrite',
      body: transaction => {
        transaction.objectStore(ARCHIVE_STORE).put(pageId, WORKER_KEY_PREFIX + workerId);
      },
    });
  } finally {
    db.close();
  }
}

/**
 * Every record the store kept. A record whose value does not have the shape its key names is left out, as if it was
 * never kept, so a damaged record costs only its own page and never the read-back. Rejects when the database cannot
 * open or the transaction fails.
 */
export async function loadPersistedArchives(indexedDB: IDBFactory): Promise<PersistedArchives> {
  const pages = new Map<string, PersistedArchive>();
  const workerPages = new Map<string, string>();
  let newest: string | null = null;
  const db = await openArchiveDb(indexedDB);
  try {
    await runIdbTransaction({
      db,
      stores: ARCHIVE_STORE,
      mode: 'readonly',
      body: transaction => {
        const cursor = transaction.objectStore(ARCHIVE_STORE).openCursor();
        cursor.onsuccess = () => {
          const record = cursor.result;
          if (record === null) {
            return;
          }
          const stored = parseStoredRecord(record.key, record.value);
          switch (stored.kind) {
            case 'page':
              pages.set(stored.id, stored.archive);
              break;
            case 'worker':
              workerPages.set(stored.id, stored.pageId);
              break;
            case 'newest':
              newest = stored.id;
              break;
            case 'other':
              break;
          }
          record.continue();
        };
      },
    });
  } finally {
    db.close();
  }
  return { pages, workerPages, newest };
}

function isRecordOfClosedClient(
  key: IDBValidKey,
  { clientId, liveClientIds }: Pick<PersistPageArchiveParams, 'clientId' | 'liveClientIds'>,
): boolean {
  const record = parseRecordKey(key);
  switch (record.kind) {
    case 'page':
    case 'worker':
      return record.id !== clientId && !liveClientIds.has(record.id);
    case 'newest':
    case 'other':
      return false;
  }
}

function parseStoredRecord(key: IDBValidKey, value: unknown): StoredRecord {
  const parsed = parseRecordKey(key);
  switch (parsed.kind) {
    case 'page':
      return isPersistedArchive(value) ? { kind: 'page', id: parsed.id, archive: value } : { kind: 'other' };
    case 'worker':
      return typeof value === 'string' ? { kind: 'worker', id: parsed.id, pageId: value } : { kind: 'other' };
    case 'newest':
      return typeof value === 'string' ? { kind: 'newest', id: value } : { kind: 'other' };
    case 'other':
      return parsed;
  }
}

function isPersistedArchive(value: unknown): value is PersistedArchive {
  return (
    isRecord(value) &&
    value['packed'] instanceof ArrayBuffer &&
    Array.isArray(value['index']) &&
    value['index'].every(isArchiveIndexEntry) &&
    typeof value['directory'] === 'string'
  );
}

function isArchiveIndexEntry(value: unknown): value is ArchiveIndex[number] {
  return (
    isRecord(value) &&
    typeof value['p'] === 'string' &&
    typeof value['o'] === 'number' &&
    typeof value['l'] === 'number'
  );
}

function parseRecordKey(key: IDBValidKey): RecordKey {
  if (typeof key !== 'string') {
    return { kind: 'other' };
  }
  if (key === NEWEST_KEY) {
    return { kind: 'newest' };
  }
  if (key.startsWith(PAGE_KEY_PREFIX)) {
    return { kind: 'page', id: key.slice(PAGE_KEY_PREFIX.length) };
  }
  if (key.startsWith(WORKER_KEY_PREFIX)) {
    return { kind: 'worker', id: key.slice(WORKER_KEY_PREFIX.length) };
  }
  return { kind: 'other' };
}

function openArchiveDb(indexedDB: IDBFactory): Promise<IDBDatabase> {
  return openIdb({
    factory: indexedDB,
    name: ARCHIVE_DB_NAME,
    version: ARCHIVE_DB_VERSION,
    // An earlier release kept one archive for every page, which no page can claim, so its store starts over.
    upgrade: db => {
      if (db.objectStoreNames.contains(ARCHIVE_STORE)) {
        db.deleteObjectStore(ARCHIVE_STORE);
      }
      db.createObjectStore(ARCHIVE_STORE);
    },
  });
}
