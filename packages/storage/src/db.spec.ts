// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { IDBDatabase, IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, it, expect, vi, type Mock } from 'vitest';
import { bindCaptureSink } from '@dotli/metrics';
import { createDbConnection, createPageDb, isExpectedDbError, type PreOpenSlot } from './db.js';

/** A connection on the previous schema that ignores `versionchange`, as a frozen older tab would. */
function openPreviousSchema(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = factory.open('dotli', 5);
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
    const getDb = createPageDb({ factory: () => factory, slot: undefined });
    const olderTab = await openPreviousSchema(factory);
    await expect(getDb()).rejects.toThrow('Failed to open dotli DB: blocked by another tab');

    // When the older tab closes and the page asks for the database again
    olderTab.close();
    const db = await getDb();

    // Then a fresh open serves it on the current schema
    expect(db.version).toBe(6);
    expect([...db.objectStoreNames]).toContain('local_wallet');
  });

  it('As a dotli user, I leave no stray connection behind after a blocked open succeeds late', async () => {
    // Given a blocked open that succeeded once the older tab closed, and the live handle released
    const factory = new IDBFactory();
    const getDb = createPageDb({ factory: () => factory, slot: undefined });
    const olderTab = await openPreviousSchema(factory);
    await expect(getDb()).rejects.toThrow('blocked by another tab');
    olderTab.close();
    (await getDb()).close();

    // When another tab upgrades the schema further
    const upgrade = await new Promise<'blocked' | 'upgraded'>(resolve => {
      const req = factory.open('dotli', 7);
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
    const getDb = createDbConnection({ open, takePreOpened: () => undefined });

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
    const getDb = createDbConnection({ open: opener(first, second), takePreOpened: () => undefined });
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
    const getDb = createDbConnection({ open: opener(first, second), takePreOpened: () => undefined });
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
    const getDb = createDbConnection({ open, takePreOpened: () => undefined });
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
    const getDb = createDbConnection({ open: opener(blocked, later), takePreOpened: () => undefined });
    await expect(getDb()).rejects.toBe(blocked);

    // When
    const db = await getDb();

    // Then
    expect(db).toBe(later.db);
  });

  it('As a page whose pre-open succeeded, my first read takes it and never opens', async () => {
    // Given
    const preOpened = fakeDb('pre');
    const open = opener();
    const getDb = createDbConnection({ open, takePreOpened: () => Promise.resolve(preOpened.db) });

    // When
    const db = await getDb();

    // Then
    expect(db).toBe(preOpened.db);
    expect(open).not.toHaveBeenCalled();
  });

  it('As an operator, a rejected pre-open is reported and the read opens afresh', async () => {
    // Given
    const captures = { exception: vi.fn(), expected: vi.fn() };
    const unbind = bindCaptureSink(captures);
    const failure = new Error('UnknownError');
    const fresh = fakeDb('fresh');
    const getDb = createDbConnection({ open: opener(fresh), takePreOpened: () => Promise.reject(failure) });

    // When
    const db = await getDb();

    // Then
    expect(db).toBe(fresh.db);
    expect(captures.exception).toHaveBeenCalledWith(failure, {
      flow: 'storage',
      step: 'db_open',
      tags: { kind: 'db_pre_opened_rejected' },
    });
    unbind();
  });

  it('As a page whose pre-open was blocked by an older tab, the block is recorded as expected and the read opens afresh', async () => {
    // Given
    const captures = { exception: vi.fn(), expected: vi.fn() };
    const unbind = bindCaptureSink(captures);
    const blocked = new Error('Failed to open dotli DB: blocked by another tab');
    const fresh = fakeDb('fresh');
    const getDb = createDbConnection({ open: opener(fresh), takePreOpened: () => Promise.reject(blocked) });

    // When
    const db = await getDb();

    // Then
    expect(db).toBe(fresh.db);
    expect(captures.expected).toHaveBeenCalledWith(blocked, { flow: 'storage', step: 'db_open' });
    expect(captures.exception).not.toHaveBeenCalled();
    unbind();
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

describe('the pre-opened database handle', () => {
  const captures = { exception: vi.fn(), expected: vi.fn() };

  beforeEach(() => {
    captures.exception.mockClear();
    captures.expected.mockClear();
    return bindCaptureSink(captures);
  });

  /** A page whose pre-open failed with `err`. */
  function preOpened(err: Error): PreOpenSlot {
    const rejected = Promise.reject(err);
    // As the inline pre-open script does, so the rejection is never unhandled.
    rejected.catch(() => undefined);
    return { __dotliDb: rejected };
  }

  it('As an operator, a pre-open that failed is reported once, with its cause, and the page still gets a database', async () => {
    // Given a pre-open that failed
    const failure = new Error('Failed to open dotli DB: UnknownError: Internal error opening backing store');
    const getDb = createPageDb({ factory: () => new IDBFactory(), slot: preOpened(failure) });

    // When the page asks for the database, and asks again after it closed
    const first = await getDb();
    first.onclose?.call(first, new Event('close'));
    await getDb();

    // Then one issue names the open step, and a fresh open served the page
    expect(first).toBeInstanceOf(IDBDatabase);
    expect(captures.exception).toHaveBeenCalledTimes(1);
    expect(captures.exception).toHaveBeenCalledWith(failure, {
      flow: 'storage',
      step: 'db_open',
      tags: { kind: 'db_pre_opened_rejected' },
    });
  });

  it('As an operator, a pre-open blocked by another tab leaves a breadcrumb, not an issue', async () => {
    // Given a pre-open another tab blocked
    const getDb = createPageDb({
      factory: () => new IDBFactory(),
      slot: preOpened(new Error('Failed to open dotli DB: blocked by another tab')),
    });

    // When the page asks for the database
    await getDb();

    // Then
    expect(captures.exception).not.toHaveBeenCalled();
    expect(captures.expected).toHaveBeenCalledWith(expect.any(Error), { flow: 'storage', step: 'db_open' });
  });
});
