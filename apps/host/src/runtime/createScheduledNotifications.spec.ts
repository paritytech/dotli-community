// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { asProductId } from '@parity/truapi';
import type { ScheduledNotificationRecord } from '@dotli/storage';
import { createDeferred } from '@dotli/shared';
import { catchError, createFakePage, createManualTimers } from '@dotli/shared/testing';
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

const DUE = {
  hostId: 1,
  perProductId: 1,
  productId: asProductId('acme.dot'),
  title: 'Acme',
  text: 'x',
  deeplink: null,
  scheduledAt: 0,
} satisfies ScheduledNotificationRecord;

/** A page and clock for the poller, with a fake Sentry and capture sink bound for this test. */
function createPollerHarness() {
  const timers = createManualTimers();
  const page = createFakePage();
  const { captures, counted } = bindReports();
  const lifecycle = createCountingTarget(page.window);
  const documentEvents = createCountingTarget(page.document);
  const visibility = {
    ...documentEvents,
    get visibilityState(): DocumentVisibilityState {
      return page.document.visibilityState;
    },
  };
  return {
    timers,
    page,
    captures,
    counted,
    /** Builds the scheduler of a lone tab over `store`, with `overrides` in its params, without starting it. */
    build,
    /** Starts the poller of a lone tab over `store` for `acme`, with `overrides` in its params. */
    start,
    /** Moves the clock on by `count` poll intervals. */
    advanceTicks,
    /** How many listeners the scheduler holds on the page's window and document. */
    countListening: (): number => lifecycle.countListening() + documentEvents.countListening(),
  };

  function build({ store, overrides = {} }: StartParams) {
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
      visibility,
      lifecycle,
      timers,
      poll: createManualPoll({ timers }),
      ...overrides,
    });
    return { notifications, show };
  }

  function start(params: StartParams) {
    const built = build(params);
    built.notifications.init({ label: 'acme' });
    return built;
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

/** Forwards to `target`, counting the listeners still attached, so a spec can check each one is removed. */
function createCountingTarget(target: EventTarget) {
  const attached: Parameters<EventTarget['removeEventListener']>[] = [];
  return {
    addEventListener,
    removeEventListener,
    dispatchEvent: (event: Event): boolean => target.dispatchEvent(event),
    /** The listeners still attached. */
    countListening: (): number => attached.length,
  };

  function addEventListener(...args: Parameters<EventTarget['addEventListener']>): void {
    attached.push([args[0], args[1]]);
    target.addEventListener(...args);
  }

  function removeEventListener(...args: Parameters<EventTarget['removeEventListener']>): void {
    const index = attached.findIndex(([type, listener]) => type === args[0] && listener === args[1]);
    if (index !== -1) {
      attached.splice(index, 1);
    }
    target.removeEventListener(...args);
  }
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

describe('scheduled notifications disposed', () => {
  it('As a user who left the page, I see no notification shown by its scheduler when one falls due afterwards', async () => {
    // Given a polling tab with a notification due in two seconds
    const { timers, start, advanceTicks } = createPollerHarness();
    const store = createRecordStore({ records: [{ ...DUE, scheduledAt: timers.now() + 2_000 }] });
    const { notifications, show } = start({ store });
    await advanceTicks(1);

    // When the scheduler is disposed and the notification falls due
    notifications.dispose();
    await advanceTicks(3);

    // Then nothing is shown, and no tick waits on the clock
    expect(show).not.toHaveBeenCalled();
    expect(timers.countPending()).toBe(0);
  });

  it('As a user who left the page, I see its scheduler hold no listener on the page', async () => {
    // Given a polling tab
    const { timers, start, advanceTicks, countListening } = createPollerHarness();
    const store = createRecordStore({ records: [{ ...DUE, scheduledAt: timers.now() + 3_600_000 }] });
    const { notifications } = start({ store });
    await advanceTicks(1);
    const listeningBeforeDispose = countListening();

    // When the scheduler is disposed
    notifications.dispose();

    // Then the page's window and document hold none of its listeners
    expect(listeningBeforeDispose).toBe(3);
    expect(countListening()).toBe(0);
  });

  it('As a user back on a page from the back-forward cache, I come back after its scheduler was disposed and its poller stays stopped', async () => {
    // Given a page with a notification due in two seconds, put into the back-forward cache and its scheduler disposed
    const { timers, page, start, advanceTicks } = createPollerHarness();
    const store = createRecordStore({ records: [{ ...DUE, scheduledAt: timers.now() + 2_000 }] });
    const { notifications, show } = start({ store });
    await advanceTicks(1);
    page.hide(true);
    notifications.dispose();

    // When the page is restored and the notification falls due
    page.window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
    await advanceTicks(3);

    // Then nothing is shown, and no tick waits on the clock
    expect(show).not.toHaveBeenCalled();
    expect(timers.countPending()).toBe(0);
  });

  it('As a user who left the page, I see the channel to its other tabs closed', () => {
    // Given a scheduler with its channel to the other tabs open
    const { start } = createPollerHarness();
    const channel = new BroadcastChannel('dotli:scheduled-notifications');
    onTestFinished(() => {
      channel.close();
    });
    const close = vi.spyOn(channel, 'close');
    const { notifications } = start({
      store: createRecordStore({ records: [] }),
      overrides: { openChannel: () => channel },
    });

    // When the scheduler is disposed
    notifications.dispose();

    // Then the channel is closed
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('As a user who left the page, I see a round already reading the store claim and show nothing', async () => {
    // Given a polling tab with a notification due in two seconds, whose next read is held
    const { timers, start, advanceTicks } = createPollerHarness();
    const record = { ...DUE, scheduledAt: timers.now() + 2_000 };
    const store = createRecordStore({ records: [record] });
    const { notifications, show } = start({ store });
    await advanceTicks(1);
    const read = createDeferred<ScheduledNotificationRecord[]>();
    store.listAll.mockReturnValueOnce(read.promise);
    await advanceTicks(1);

    // When the scheduler is disposed while the round reads, and the read then finds the notification due
    notifications.dispose();
    read.resolve([record]);
    await advanceTicks(1);

    // Then it is not claimed, so it stays for another tab or the next load, and nothing is shown
    expect(store.removeById).not.toHaveBeenCalled();
    expect(show).not.toHaveBeenCalled();
  });

  it('As a dApp user, I start a scheduler already disposed and it opens no channel, fires nothing and starts no poller', async () => {
    // Given a scheduler disposed before it started, over a store holding a due notification
    const { timers, build, advanceTicks, countListening } = createPollerHarness();
    const opened: string[] = [];
    const store = createRecordStore({ records: [DUE] });
    const { notifications, show } = build({
      store,
      overrides: {
        openChannel: name => {
          opened.push(name);
          return null;
        },
      },
    });
    notifications.dispose();

    // When it is started
    notifications.init({ label: 'acme' });
    await advanceTicks(2);

    // Then no channel opens, nothing is read or shown, and nothing listens or waits on the clock
    expect(opened).toEqual([]);
    expect(store.listAll).not.toHaveBeenCalled();
    expect(show).not.toHaveBeenCalled();
    expect(countListening()).toBe(0);
    expect(timers.countPending()).toBe(0);
  });

  it('As a dApp user, I schedule a notification after the scheduler was disposed and it is stored, while the scheduler shows nothing', async () => {
    // Given a disposed scheduler over a store holding a notification due in two seconds
    const { timers, start, advanceTicks } = createPollerHarness();
    const store = createRecordStore({ records: [{ ...DUE, scheduledAt: timers.now() + 2_000 }] });
    store.schedule.mockResolvedValue({ ok: true, id: 2 });
    const { notifications, show } = start({ store });
    await advanceTicks(1);
    notifications.dispose();

    // When a notification is scheduled and both fall due
    const result = await notifications.schedule({ ...DUE, scheduledAt: timers.now() + 2_000 });
    await advanceTicks(3);

    // Then the store holds it, and no poller starts to show either
    expect(result).toEqual({ ok: true, id: 2, immediate: false });
    expect(store.schedule).toHaveBeenCalledTimes(1);
    expect(show).not.toHaveBeenCalled();
    expect(timers.countPending()).toBe(0);
  });

  it('As a dApp user, I cancel a notification after the scheduler was disposed and it is removed from the store', async () => {
    // Given a disposed scheduler over a store that holds the notification
    const { start } = createPollerHarness();
    const store = createRecordStore({ records: [] });
    store.cancel.mockResolvedValue(true);
    const { notifications } = start({ store });
    notifications.dispose();

    // When the notification is cancelled
    const removed = await notifications.cancel(asProductId('acme.dot'), 1);

    // Then the store removed it
    expect(removed).toBe(true);
    expect(store.cancel).toHaveBeenCalledWith('acme.dot', 1);
  });

  it('As a user who leaves the page twice over, I dispose the scheduler again and it does not throw', () => {
    // Given a disposed scheduler
    const { start } = createPollerHarness();
    const { notifications } = start({ store: createRecordStore({ records: [] }) });
    notifications.dispose();

    // When it is disposed again
    const thrown = catchError(notifications.dispose);

    // Then it does not throw
    expect(thrown).toBeUndefined();
  });

  it('As a user whose notifications failed to load, I leave the page and the scheduler is disposed without throwing', async () => {
    // Given a scheduler whose every read of the store failed
    const { start, advanceTicks, countListening } = createPollerHarness();
    const store = createRecordStore({ records: [] });
    store.listAll.mockRejectedValue(new Error('disk gone'));
    const { notifications } = start({ store });
    await advanceTicks(1);

    // When the scheduler is disposed
    const thrown = catchError(notifications.dispose);

    // Then it does not throw, and holds no listener on the page
    expect(thrown).toBeUndefined();
    expect(countListening()).toBe(0);
  });
});
