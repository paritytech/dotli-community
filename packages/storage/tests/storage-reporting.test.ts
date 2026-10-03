// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NetworkName } from '@dotli/config';
import type * as Metrics from '@dotli/metrics';

const sentry = vi.hoisted(() => ({ captureException: vi.fn(), recordExpected: vi.fn() }));
vi.mock('@dotli/metrics', async importOriginal => ({
  ...(await importOriginal<typeof Metrics>()),
  ...sentry,
}));

import { evictCachedCid, setCachedCid } from '../src/cid-cache.js';
import { getDb, isExpectedDbError } from '../src/db.js';

const MANIFESTS = { root: null, app: null };

function failTransactions(err: Error): void {
  vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(() => {
    throw err;
  });
}

describe('isExpectedDbError', () => {
  it.each([
    new DOMException(
      "Failed to execute 'transaction' on 'IDBDatabase': The database connection is closing.",
      'InvalidStateError',
    ),
    new DOMException('An attempt was made to use an object that is not, or is no longer, usable', 'InvalidStateError'),
    new Error('Failed to open dotli DB: blocked by another tab'),
  ])('treats "%s" as expected', err => {
    expect(isExpectedDbError(err)).toBe(true);
  });

  it.each([
    new DOMException('quota', 'QuotaExceededError'),
    new Error('Failed to open dotli DB: VersionError'),
    'The database connection is closing',
  ])('treats "%s" as a fault', err => {
    expect(isExpectedDbError(err)).toBe(false);
  });
});

describe('cid-cache failure reporting', () => {
  beforeEach(async () => {
    await getDb();
    sentry.captureException.mockClear();
    sentry.recordExpected.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('As an operator, a connection closing under an unloading page leaves a breadcrumb, not an issue', async () => {
    // Given a connection that is closing
    failTransactions(new DOMException('The database connection is closing.', 'InvalidStateError'));

    // When the cache writes
    await setCachedCid('myapp', NetworkName.PASEO, 'bafy', MANIFESTS);

    // Then the failure is recorded as expected
    expect(sentry.captureException).not.toHaveBeenCalled();
    expect(sentry.recordExpected).toHaveBeenCalledWith(expect.any(DOMException), {
      flow: 'storage',
      step: 'cid_cache_write',
    });
  });

  it('As an operator, a stuck cache reports each failing action once per page', async () => {
    // Given a cache whose every transaction fails
    const failure = new Error('disk gone');
    failTransactions(failure);

    // When it evicts twice
    await evictCachedCid('a');
    await evictCachedCid('b');

    // Then one issue names the storage flow and the evict step
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    expect(sentry.captureException).toHaveBeenCalledWith(failure, {
      flow: 'storage',
      step: 'cid_cache_evict',
      tags: { kind: 'cid_cache_evict_error' },
    });
  });
});

describe('the pre-opened database handle', () => {
  beforeEach(() => {
    vi.resetModules();
    sentry.captureException.mockClear();
    sentry.recordExpected.mockClear();
  });

  afterEach(() => {
    delete window.__dotliDb;
  });

  function preOpen(err: Error): void {
    const rejected = Promise.reject(err);
    // As the inline pre-open script does, so the rejection is never unhandled.
    rejected.catch(() => undefined);
    window.__dotliDb = rejected;
  }

  it('As an operator, a pre-open that failed is reported once, with its cause, and the page still gets a database', async () => {
    // Given a pre-open that failed
    const failure = new Error('Failed to open dotli DB: UnknownError: Internal error opening backing store');
    preOpen(failure);
    const db = await import('../src/db.js');

    // When the page asks for the database, and asks again after it closed
    const first = await db.getDb();
    first.onclose?.call(first, new Event('close'));
    await db.getDb();

    // Then one issue names the open step, and a fresh open served the page
    expect(first).toBeInstanceOf(IDBDatabase);
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    expect(sentry.captureException).toHaveBeenCalledWith(failure, {
      flow: 'storage',
      step: 'db_open',
      tags: { kind: 'db_pre_opened_rejected' },
    });
  });

  it('As an operator, a pre-open blocked by another tab leaves a breadcrumb, not an issue', async () => {
    // Given a pre-open another tab blocked
    preOpen(new Error('Failed to open dotli DB: blocked by another tab'));
    const { getDb } = await import('../src/db.js');

    // When the page asks for the database
    await getDb();

    // Then
    expect(sentry.captureException).not.toHaveBeenCalled();
    expect(sentry.recordExpected).toHaveBeenCalledWith(expect.any(Error), { flow: 'storage', step: 'db_open' });
  });
});
