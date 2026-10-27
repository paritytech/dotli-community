// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, beforeEach } from 'vitest';
import {
  createScheduledNotifications,
  type ScheduledNotificationRecord,
  type ScheduledNotifications,
} from './scheduledNotifications.js';
import { createMemoryIdb, type MemoryIdb } from './testing/index.js';

// Each test gets a fresh database, so no test sees another's records.
let idb: MemoryIdb;
let queue: ScheduledNotifications;

beforeEach(() => {
  idb = createMemoryIdb();
  queue = createScheduledNotifications({ idb });
});

async function listRecordsOf(productId: string): Promise<ScheduledNotificationRecord[]> {
  return (await queue.listAll()).filter(record => record.productId === productId);
}

function getTimeFromNow(ms: number): number {
  return Date.now() + ms;
}

function getTimeAgo(ms: number): number {
  return Date.now() - ms;
}

describe('schedule', () => {
  it('As a dapp, I schedule two notifications and get monotonic per-product ids starting at 1', async () => {
    // Given a product with no scheduled notifications

    // When the dapp schedules two
    const first = await queue.schedule({
      productId: 'acme.dot',
      title: 'Acme',
      text: 'first',
      deeplink: null,
      scheduledAt: getTimeFromNow(60_000),
    });
    const second = await queue.schedule({
      productId: 'acme.dot',
      title: 'Acme',
      text: 'second',
      deeplink: null,
      scheduledAt: getTimeFromNow(120_000),
    });

    // Then the ids increment from 1
    expect(first).toEqual({ ok: true, id: 1 });
    expect(second).toEqual({ ok: true, id: 2 });
  });

  it('As a dapp, I schedule for two products and each counts its ids from 1', async () => {
    // Given two distinct products

    // When each schedules its first notification
    const acme = await queue.schedule({
      productId: 'acme.dot',
      title: 'Acme',
      text: 'x',
      deeplink: null,
      scheduledAt: getTimeFromNow(60_000),
    });
    const bravo = await queue.schedule({
      productId: 'bravo.dot',
      title: 'Bravo',
      text: 'y',
      deeplink: null,
      scheduledAt: getTimeFromNow(60_000),
    });

    // Then both start at id 1
    expect(acme).toEqual({ ok: true, id: 1 });
    expect(bravo).toEqual({ ok: true, id: 1 });
  });

  it('As a dapp, I hit ScheduleLimitReached on the 21st pending notification for one product', async () => {
    // Given a product already at the per-product cap of 20
    for (let index = 0; index < 20; index += 1) {
      await queue.schedule({
        productId: 'acme.dot',
        title: 'Acme',
        text: `n=${String(index)}`,
        deeplink: null,
        scheduledAt: getTimeFromNow(60_000 + index),
      });
    }

    // When it schedules one more
    const overflow = await queue.schedule({
      productId: 'acme.dot',
      title: 'Acme',
      text: 'overflow',
      deeplink: null,
      scheduledAt: getTimeFromNow(120_000),
    });

    // Then the schedule is rejected with ScheduleLimitReached
    expect(overflow).toEqual({ ok: false, error: 'ScheduleLimitReached' });
  });

  it('As a dapp, I schedule for one product while another is at the cap and get its own id 1', async () => {
    // Given acme is at the cap of 20
    for (let index = 0; index < 20; index += 1) {
      await queue.schedule({
        productId: 'acme.dot',
        title: 'Acme',
        text: `n=${String(index)}`,
        deeplink: null,
        scheduledAt: getTimeFromNow(60_000 + index),
      });
    }

    // When a different product schedules
    const bravo = await queue.schedule({
      productId: 'bravo.dot',
      title: 'Bravo',
      text: 'ok',
      deeplink: null,
      scheduledAt: getTimeFromNow(60_000),
    });

    // Then it succeeds at its own id 1
    expect(bravo).toEqual({ ok: true, id: 1 });
  });

  it('As a dapp, I schedule again after a cancel and get a new id, not the cancelled one', async () => {
    // Given a scheduled notification that is then cancelled
    await queue.schedule({
      productId: 'acme.dot',
      title: 'Acme',
      text: 'a',
      deeplink: null,
      scheduledAt: getTimeFromNow(60_000),
    });
    await queue.cancel('acme.dot', 1);

    // When the dapp schedules again
    const second = await queue.schedule({
      productId: 'acme.dot',
      title: 'Acme',
      text: 'b',
      deeplink: null,
      scheduledAt: getTimeFromNow(60_000),
    });

    // Then the new id is 2, not the reclaimed 1
    expect(second).toEqual({ ok: true, id: 2 });
  });
});

describe('cancel', () => {
  it('As a dapp, I cancel a pending notification and it is removed', async () => {
    // Given one pending notification
    await queue.schedule({
      productId: 'acme.dot',
      title: 'Acme',
      text: 'x',
      deeplink: null,
      scheduledAt: getTimeFromNow(60_000),
    });

    // When the dapp cancels it
    const removed = await queue.cancel('acme.dot', 1);

    // Then cancel reports success and the queue is empty
    expect(removed).toBe(true);
    expect(await listRecordsOf('acme.dot')).toEqual([]);
  });

  it('As a dapp, I cancel the same notification twice and the second is a no-op', async () => {
    // Given one pending notification
    await queue.schedule({
      productId: 'acme.dot',
      title: 'Acme',
      text: 'x',
      deeplink: null,
      scheduledAt: getTimeFromNow(60_000),
    });

    // When the dapp cancels it twice
    const first = await queue.cancel('acme.dot', 1);
    const second = await queue.cancel('acme.dot', 1);

    // Then the first removes it and the second is a no-op
    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it("As a dapp, I cannot cancel another product's notification", async () => {
    // Given acme has a pending notification
    await queue.schedule({
      productId: 'acme.dot',
      title: 'Acme',
      text: 'x',
      deeplink: null,
      scheduledAt: getTimeFromNow(60_000),
    });

    // When a different product tries to cancel id 1
    const removed = await queue.cancel('bravo.dot', 1);

    // Then nothing is removed and acme's notification survives
    expect(removed).toBe(false);
    expect(await listRecordsOf('acme.dot')).toHaveLength(1);
  });
});

describe('allocateId', () => {
  it('As the immediate-fire path, I allocate an id without persisting a record', async () => {
    // Given a product with no scheduled notifications

    // When the immediate-fire path allocates an id
    const id = await queue.allocateId('acme.dot');

    // Then it gets id 1 and nothing is queued
    expect(id).toBe(1);
    expect(await listRecordsOf('acme.dot')).toEqual([]);
  });

  it('As the immediate-fire path, I allocate ids around a schedule and all share one monotonic counter', async () => {
    // Given an immediate allocation
    const allocated = await queue.allocateId('acme.dot');

    // When a scheduled notification and another allocation follow
    const scheduled = await queue.schedule({
      productId: 'acme.dot',
      title: 'Acme',
      text: 'x',
      deeplink: null,
      scheduledAt: getTimeFromNow(60_000),
    });
    const allocatedAgain = await queue.allocateId('acme.dot');

    // Then ids stay monotonic across both paths
    expect(allocated).toBe(1);
    expect(scheduled).toEqual({ ok: true, id: 2 });
    expect(allocatedAgain).toBe(3);
  });
});

describe('removeById', () => {
  it('As the scheduler, I remove a record by hostId and learn whether it existed', async () => {
    // Given one queued record
    await queue.schedule({
      productId: 'acme.dot',
      title: 'Acme',
      text: 'x',
      deeplink: null,
      scheduledAt: getTimeFromNow(60_000),
    });
    const [record] = await listRecordsOf('acme.dot');
    if (record === undefined) {
      throw new Error('expected the scheduled record');
    }

    // When removing it by hostId twice
    const first = await queue.removeById(record.hostId);
    const second = await queue.removeById(record.hostId);

    // Then the first reports it existed and the second does not
    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(await listRecordsOf('acme.dot')).toEqual([]);
  });
});

describe('removeStale', () => {
  it('As the scheduler, I drop records older than the staleness cutoff and keep fresh ones', async () => {
    // Given one record older than the 24h window and one within it
    const dayMs = 24 * 60 * 60 * 1000;
    await queue.schedule({
      productId: 'acme.dot',
      title: 'Acme',
      text: 'old',
      deeplink: null,
      scheduledAt: getTimeAgo(dayMs + 60_000),
    });
    await queue.schedule({
      productId: 'acme.dot',
      title: 'Acme',
      text: 'fresh',
      deeplink: null,
      scheduledAt: getTimeAgo(60_000),
    });

    // When pruning stale records
    const removed = await queue.removeStale(Date.now());

    // Then only the stale one is gone
    expect(removed).toBe(1);
    const remaining = await listRecordsOf('acme.dot');
    expect(remaining.map(record => record.text)).toEqual(['fresh']);
  });

  it('As the scheduler, I remove stale records when none is stale and am told 0', async () => {
    // Given a single fresh record
    await queue.schedule({
      productId: 'acme.dot',
      title: 'Acme',
      text: 'fresh',
      deeplink: null,
      scheduledAt: getTimeAgo(60_000),
    });

    // When pruning stale records
    const removed = await queue.removeStale(Date.now());

    // Then nothing is removed
    expect(removed).toBe(0);
  });
});

describe('a database connection that is closed', () => {
  it('As the scheduler, I schedule on a closed connection and the call rejects rather than hangs', async () => {
    // Given the cached connection has closed, as it does under an unloading page
    (await idb.connect()).close();

    // When the scheduler schedules a notification
    const scheduled = queue.schedule({
      productId: 'acme.dot',
      title: 'Acme',
      text: 'x',
      deeplink: null,
      scheduledAt: Date.now() + 60_000,
    });

    // Then the call rejects with that error
    await expect(scheduled).rejects.toMatchObject({ name: 'InvalidStateError' });
  });
});
