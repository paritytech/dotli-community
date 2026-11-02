// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, vi, type Mock } from 'vitest';
import { IdbOpenBlockedError, openIdb } from '@dotli/shared';
import { createDbConnection } from './createDbConnection.js';
import { DB_NAME, DB_VERSION, upgradeDotliDb } from './schema.js';

/** A connection on the previous schema that ignores `versionchange`, as a frozen older tab would. */
function openPreviousSchema(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DB_NAME, DB_VERSION - 1);
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error('open failed'));
    };
  });
}

/** Resolves what `pending` rejects with, or null when it resolves. */
function getFailure(pending: Promise<unknown>): Promise<unknown> {
  return pending.then(
    () => null,
    (error: unknown) => error,
  );
}

/** A connection whose close and version change the test fires, as the browser would. */
type FakeDb = ReturnType<typeof createFakeDb>;

function createFakeDb(name: string) {
  const db = {
    name,
    // The handler slots start empty, as the browser's do, and the connection under test fills them.
    onclose: null as ((this: IDBDatabase, event: Event) => unknown) | null,
    onversionchange: null as ((this: IDBDatabase, event: IDBVersionChangeEvent) => unknown) | null,
    close: vi.fn<() => void>(),
  };
  // The connection reads only the handlers and `close`, which the fake has.
  const handle = db as unknown as IDBDatabase;
  return {
    db: handle,
    close: db.close,
    fireClose: () => {
      db.onclose?.call(handle, new Event('close'));
    },
    fireVersionChange: () => {
      // The connection's handler reads no field a version change event adds.
      db.onversionchange?.call(handle, new Event('versionchange') as IDBVersionChangeEvent);
    },
  };
}

/** Opens the given connections in turn, or fails where an entry is an error. */
function createOpener(...results: (FakeDb | Error)[]): Mock<() => Promise<IDBDatabase>> {
  return vi.fn<() => Promise<IDBDatabase>>(() => {
    const next = results.shift();
    if (next === undefined) {
      return Promise.reject(new Error('no more opens in this test'));
    }
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next.db);
  });
}

describe('the dotli database connection', () => {
  it('As a dotli user, I open the database again after an older tab blocked it and get a connection', async () => {
    // Given an older tab that holds the database on the previous schema, which blocked the page's first open
    const factory = new IDBFactory();
    const getDb = createDbConnection({
      open: () => openIdb({ factory, name: DB_NAME, version: DB_VERSION, upgrade: upgradeDotliDb }),
    });
    const olderTab = await openPreviousSchema(factory);
    const blockedOpen = await getFailure(getDb());

    // When the older tab closes and the page asks for the database again
    olderTab.close();
    const db = await getDb();

    // Then a fresh open serves it on the current schema
    expect(blockedOpen).toBeInstanceOf(IdbOpenBlockedError);
    expect(db.version).toBe(DB_VERSION);
    expect([...db.objectStoreNames]).not.toContain('local_wallet');
  });
});

describe('createDbConnection', () => {
  it('As a page, I read twice at once and both reads share one connection', async () => {
    // Given
    const first = createFakeDb('first');
    const open = createOpener(first);
    const getDb = createDbConnection({ open });

    // When
    const both = await Promise.all([getDb(), getDb()]);

    // Then
    expect(both).toEqual([first.db, first.db]);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('As a page whose connection closed, I read again and get a new connection', async () => {
    // Given a connection that closed
    const first = createFakeDb('first');
    const second = createFakeDb('second');
    const getDb = createDbConnection({ open: createOpener(first, second) });
    await getDb();
    first.fireClose();

    // When
    const db = await getDb();

    // Then
    expect(db).toBe(second.db);
  });

  it('As a page whose connection another tab upgrades past, I close it and my next read opens a new one', async () => {
    // Given
    const first = createFakeDb('first');
    const second = createFakeDb('second');
    const getDb = createDbConnection({ open: createOpener(first, second) });
    await getDb();

    // When
    first.fireVersionChange();
    const db = await getDb();

    // Then
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(db).toBe(second.db);
  });

  it('As a page, I keep the newer connection when a connection I already replaced reports a late close', async () => {
    // Given a connection replaced after a version change
    const first = createFakeDb('first');
    const second = createFakeDb('second');
    const open = createOpener(first, second);
    const getDb = createDbConnection({ open });
    await getDb();
    first.fireVersionChange();
    await getDb();

    // When the old one reports its close, and the page reads again
    first.fireClose();
    const db = await getDb();

    // Then
    expect(db).toBe(second.db);
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('As a page whose open was blocked, I read again and the next open serves me', async () => {
    // Given an open an older tab blocked
    const blocked = new IdbOpenBlockedError('dotli');
    const later = createFakeDb('later');
    const getDb = createDbConnection({ open: createOpener(blocked, later) });
    const blockedOpen = await getFailure(getDb());

    // When
    const db = await getDb();

    // Then
    expect(blockedOpen).toBe(blocked);
    expect(db).toBe(later.db);
  });
});
