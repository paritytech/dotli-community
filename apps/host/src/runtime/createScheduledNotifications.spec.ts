// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import type { ScheduledNotificationRecord } from '@dotli/storage';
import { createDeferred } from '@dotli/shared';
import { createFakePage, createManualTimers } from '@dotli/shared/testing';
import { bindReports } from '../testing/bindReports.js';
import { createManualPoll } from '../testing/createManualPoll.js';
import {
  createScheduledNotifications,
  SCHEDULED_NOTIFICATIONS_POLL_INTERVAL_MS,
  type ScheduledNotificationsParams,
  type ScheduledNotificationStore,
} from './createScheduledNotifications.js';

type StartParams = {
  /** The store the poller claims its records from. */
  store: ScheduledNotificationStore;
  /** Params that replace the harness's own, none by default. */
  overrides?: Partial<ScheduledNotificationsParams>;
};

type CreateRecordStoreParams = {
  /** The records the store holds at first. */
  records: ScheduledNotificationRecord[];
};

const DUE: ScheduledNotificationRecord = {
  hostId: 1,
  perProductId: 1,
  productId: 'acme.dot',
  title: 'Acme',
  text: 'x',
  deeplink: null,
  scheduledAt: 0,
};

/** A page and clock for the poller, with a fake Sentry and capture sink bound for this test. */
function createPollerHarness() {
  const timers = createManualTimers();
  const page = createFakePage();
  const { captures, counted } = bindReports();
  return {
    timers,
    page,
    captures,
    counted,
    /** Starts the poller of a lone tab over `store` for `acme`, with `overrides` in its params. */
    start,
    /** Moves the clock on by `count` poll intervals. */
    advanceTicks,
  };

  function start({ store, overrides = {} }: StartParams) {
    const show = vi.fn<ScheduledNotificationsParams['show']>();
    const notifications = createScheduledNotifications({
      store,
      show,
      // A lone tab always gets the lock.
      locks: {
        // One plain function cannot meet the overloads of `request`.
        request: ((_name: string, _options: unknown, run: (lock: object) => unknown) =>
          run({})) as LockManager['request'],
      },
      openChannel: () => null,
      visibility: page.document,
      lifecycle: page.window,
      timers,
      poll: createManualPoll({ timers }),
      ...overrides,
    });
    notifications.init({ label: 'acme' });
    return { notifications, show };
  }

  async function advanceTicks(count: number): Promise<void> {
    for (let tick = 0; tick < count; tick++) {
      await timers.advance(SCHEDULED_NOTIFICATIONS_POLL_INTERVAL_MS);
    }
  }
}

/** Holds the given records, so a record removed once is gone for every later claim. */
function createRecordStore({ records }: CreateRecordStoreParams) {
  const held = new Map(records.map(record => [record.hostId, record]));
  return {
    schedule: vi.fn<ScheduledNotificationStore['schedule']>(),
    cancel: vi.fn<ScheduledNotificationStore['cancel']>(),
    allocateId: vi.fn<ScheduledNotificationStore['allocateId']>(),
    listAll: vi.fn<ScheduledNotificationStore['listAll']>(() => Promise.resolve([...held.values()])),
    removeStale: vi.fn<ScheduledNotificationStore['removeStale']>(() => Promise.resolve(0)),
    removeById: vi.fn<ScheduledNotificationStore['removeById']>(hostId => Promise.resolve(held.delete(hostId))),
  };
}

function createClosingError(): DOMException {
  return new DOMException(
    "Failed to execute 'transaction' on 'IDBDatabase': The database connection is closing.",
    'InvalidStateError',
  );
}

describe('scheduled notifications poller', () => {
  it('As an operator, I watch a tab whose database connection keeps closing and see one breadcrumb per step, not an issue per tick', async () => {
    // Given a polling tab whose database connection starts closing
    const { timers, captures, start, advanceTicks } = createPollerHarness();
    const store = createRecordStore({ records: [{ ...DUE, scheduledAt: timers.now() + 3_600_000 }] });
    start({ store });
    await advanceTicks(1);
    store.removeStale.mockRejectedValue(createClosingError());
    store.listAll.mockRejectedValue(createClosingError());

    // When the poller ticks for several seconds
    await advanceTicks(5);

    // Then each step records it once as expected, and nothing is captured
    expect(captures.exception).not.toHaveBeenCalled();
    expect(captures.expected).toHaveBeenCalledTimes(2);
    expect(captures.expected).toHaveBeenCalledWith(expect.any(DOMException), {
      flow: 'notifications',
      step: 'list_pending',
    });
  });

  it('As an operator, I watch a tick that the page unload catches and see nothing reported', async () => {
    // Given a polling tab whose next read is held
    const { timers, page, captures, start, advanceTicks } = createPollerHarness();
    const store = createRecordStore({ records: [{ ...DUE, scheduledAt: timers.now() + 3_600_000 }] });
    start({ store });
    await advanceTicks(1);
    const read = createDeferred<ScheduledNotificationRecord[]>();
    store.listAll.mockReturnValue(read.promise);

    // When the page hides while a tick is reading and the read then fails
    await timers.advance(SCHEDULED_NOTIFICATIONS_POLL_INTERVAL_MS);
    page.window.dispatchEvent(new Event('pagehide'));
    read.reject(createClosingError());
    await advanceTicks(3);

    // Then nothing is reported
    expect(captures.exception).not.toHaveBeenCalled();
    expect(captures.expected).not.toHaveBeenCalled();
  });

  it('As an operator, I watch a claim that keeps failing and see it captured once, not left unhandled', async () => {
    // Given a due record whose claim fails
    const { captures, start, advanceTicks } = createPollerHarness();
    const failure = new Error('disk gone');
    const store = createRecordStore({ records: [DUE] });
    store.removeById.mockRejectedValue(failure);

    // When the poller ticks for several seconds
    start({ store });
    await advanceTicks(5);

    // Then the failure is captured once, under the claim step
    expect(captures.exception).toHaveBeenCalledTimes(1);
    expect(captures.exception).toHaveBeenCalledWith(failure, { flow: 'notifications', step: 'claim' });
  });

  it('As an operator, I watch a poll step fail with a browser-caused database error and it is counted as expected under the poll metric', async () => {
    // Given a polling tab whose list step starts failing on a closing database connection
    const { timers, captures, counted, start, advanceTicks } = createPollerHarness();
    const store = createRecordStore({ records: [{ ...DUE, scheduledAt: timers.now() + 3_600_000 }] });
    start({ store });
    await advanceTicks(1);
    store.listAll.mockRejectedValue(createClosingError());

    // When the poller ticks for several seconds
    await advanceTicks(3);

    // Then the step is counted once as an expected failure, and nothing is captured
    expect(counted('notifications.poll')).toEqual([
      { outcome: 'error', reason: 'InvalidStateError', step: 'list_pending' },
    ]);
    expect(captures.exception).not.toHaveBeenCalled();
  });

  it('As an operator, I see a poll step that fails with a fault captured and counted under the poll metric', async () => {
    // Given a polling tab whose list step starts failing on a fault
    const { timers, captures, counted, start, advanceTicks } = createPollerHarness();
    const failure = new Error('disk gone');
    const store = createRecordStore({ records: [{ ...DUE, scheduledAt: timers.now() + 3_600_000 }] });
    start({ store });
    await advanceTicks(1);
    store.listAll.mockRejectedValue(failure);

    // When the poller ticks for several seconds
    await advanceTicks(3);

    // Then the step is captured and counted once
    expect(captures.exception.mock.calls).toEqual([[failure, { flow: 'notifications', step: 'list_pending' }]]);
    expect(counted('notifications.poll')).toEqual([{ outcome: 'error', reason: 'Error', step: 'list_pending' }]);
  });

  it('As a user, I load a page with a due notification the poller also reaches and it shows once', async () => {
    // Given a due record whose claim at page load is slow to land
    const { timers, start, advanceTicks } = createPollerHarness();
    const store = createRecordStore({ records: [DUE] });
    const removeRecord = store.removeById.getMockImplementation();
    const landed = createDeferred<undefined>();
    store.removeById.mockImplementationOnce(async hostId => {
      await landed.promise;
      return (await removeRecord?.(hostId)) ?? false;
    });
    store.schedule.mockResolvedValue({ ok: true, id: 2 });
    // Without Web Locks, so nothing but the claim itself keeps the two apart.
    const { notifications, show } = start({ store, overrides: { locks: undefined } });

    // When a newly scheduled notification starts the poller, which reaches the record while that claim still runs
    await notifications.schedule({ ...DUE, scheduledAt: timers.now() + 3_600_000 });
    await advanceTicks(2);
    landed.resolve(undefined);
    await advanceTicks(1);

    // Then it shows once, as the page load found it
    expect(show).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledWith(expect.objectContaining({ label: 'Acme', browserNotification: false }));
  });

  it('As a user back on a page from the back-forward cache, I come back and a notification that fell due meanwhile still shows', async () => {
    // Given a page with a notification due in two seconds, put into the back-forward cache
    const { timers, page, start, advanceTicks } = createPollerHarness();
    const store = createRecordStore({ records: [{ ...DUE, scheduledAt: timers.now() + 2_000 }] });
    const { show } = start({ store });
    await advanceTicks(1);
    page.window.dispatchEvent(new Event('pagehide'));
    await advanceTicks(3);
    const shownWhileCached = show.mock.calls.length;

    // When the page is restored
    page.window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
    await advanceTicks(1);

    // Then it showed nothing while cached, and once after
    expect(shownWhileCached).toBe(0);
    expect(show).toHaveBeenCalledTimes(1);
  });

  it('As a user, I load a page and its first pageshow opens no second channel', () => {
    // Given
    const { page, start } = createPollerHarness();
    const opened: string[] = [];
    start({
      store: createRecordStore({ records: [] }),
      overrides: {
        openChannel: name => {
          opened.push(name);
          return null;
        },
      },
    });

    // When
    page.window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: false }));

    // Then
    expect(opened).toEqual(['dotli:scheduled-notifications']);
  });
});
