// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, vi, type Mock } from 'vitest';
import { createDbConnection, isExpectedDbError } from './db.js';
import { openIdb } from '@dotli/shared';
import { DB_NAME, DB_VERSION, upgradeDotliDb } from './schema.js';

/** A connection on the previous schema that ignores `versionchange`, as a frozen older tab would. */
function openPreviousSchema(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = factory.open(DB_NAME, DB_VERSION - 1);
    req.onsuccess = () => {
      resolve(req.result);
    };
    req.onerror = () => {
      reject(req.error ?? new Error('open failed'));
    };
  });
}

describe('the dotli database connection', () => {
  it('As a dotli user, I open the database again after an older tab blocked it and get a connection', async () => {
    // Given an older tab that holds the database on the previous schema
    const factory = new IDBFactory();
    const getDb = createDbConnection(() => openIdb(factory, DB_NAME, DB_VERSION, upgradeDotliDb));
    const olderTab = await openPreviousSchema(factory);
    await expect(getDb()).rejects.toThrow('Failed to open dotli DB: blocked by another tab');

    // When the older tab closes and the page asks for the database again
    olderTab.close();
    const db = await getDb();

    // Then a fresh open serves it on the current schema
    expect(db.version).toBe(DB_VERSION);
    expect([...db.objectStoreNames]).not.toContain('local_wallet');
  });
});

/** A connection whose close and version change the test fires, as the browser would. */
interface FakeDb {
  db: IDBDatabase;
  close: Mock<() => void>;
  closed: () => void;
  versionChange: () => void;
}

function fakeDb(name: string): FakeDb {
  const db = {
    name,
    onclose: null as ((this: IDBDatabase, ev: Event) => unknown) | null,
    onversionchange: null as ((this: IDBDatabase, ev: IDBVersionChangeEvent) => unknown) | null,
    close: vi.fn<() => void>(),
  };
  const handle = db as unknown as IDBDatabase;
  return {
    db: handle,
    close: db.close,
    closed: () => {
      db.onclose?.call(handle, new Event('close'));
    },
    versionChange: () => {
      db.onversionchange?.call(handle, new Event('versionchange') as IDBVersionChangeEvent);
    },
  };
}

/** Opens the given connections in turn, or fails where an entry is an error. */
function opener(...results: (FakeDb | Error)[]): ReturnType<typeof vi.fn<() => Promise<IDBDatabase>>> {
  return vi.fn<() => Promise<IDBDatabase>>(() => {
    const next = results.shift();
    if (next === undefined) {
      return Promise.reject(new Error('no more opens in this test'));
    }
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next.db);
  });
}

describe('createDbConnection', () => {
  it('As a page, two reads at once share one connection', async () => {
    // Given
    const first = fakeDb('first');
    const open = opener(first);
    const getDb = createDbConnection(open);

    // When
    const both = await Promise.all([getDb(), getDb()]);

    // Then
    expect(both).toEqual([first.db, first.db]);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('As a page whose connection closed, my next read opens a new one', async () => {
    // Given
    const first = fakeDb('first');
    const second = fakeDb('second');
    const getDb = createDbConnection(opener(first, second));
    await getDb();

    // When
    first.closed();

    // Then
    expect(await getDb()).toBe(second.db);
  });

  it('As a page whose connection another tab upgrades past, I close it and my next read opens a new one', async () => {
    // Given
    const first = fakeDb('first');
    const second = fakeDb('second');
    const getDb = createDbConnection(opener(first, second));
    await getDb();

    // When
    first.versionChange();

    // Then
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(await getDb()).toBe(second.db);
  });

  it('As a page, a late close of a connection I already replaced keeps the newer one', async () => {
    // Given a connection replaced after a version change
    const first = fakeDb('first');
    const second = fakeDb('second');
    const open = opener(first, second);
    const getDb = createDbConnection(open);
    await getDb();
    first.versionChange();
    await getDb();

    // When the old one reports its close
    first.closed();

    // Then
    expect(await getDb()).toBe(second.db);
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('As a page whose open failed, my next read opens again', async () => {
    // Given
    const blocked = new Error('Failed to open dotli DB: blocked by another tab');
    const later = fakeDb('later');
    const getDb = createDbConnection(opener(blocked, later));
    await expect(getDb()).rejects.toBe(blocked);

    // When
    const db = await getDb();

    // Then
    expect(db).toBe(later.db);
  });
});

describe('isExpectedDbError', () => {
  it.each([
    new DOMException(
      "Failed to execute 'transaction' on 'IDBDatabase': The database connection is closing.",
      'InvalidStateError',
    ),
    new DOMException('An attempt was made to use an object that is not, or is no longer, usable', 'InvalidStateError'),
    new Error('Failed to open dotli DB: blocked by another tab'),
  ])('As a store whose database is closing or blocked, I take "%s" as expected and do not report it', err => {
    // When / Then
    expect(isExpectedDbError(err)).toBe(true);
  });

  it.each([
    new DOMException('quota', 'QuotaExceededError'),
    new Error('Failed to open dotli DB: VersionError'),
    'The database connection is closing',
  ])('As a store whose database fails, I take "%s" as a fault to report', err => {
    // When / Then
    expect(isExpectedDbError(err)).toBe(false);
  });
});
