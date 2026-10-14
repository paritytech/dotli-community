// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SCHEDULED_NOTIFICATIONS_POLL_INTERVAL_MS } from './scheduled-notifications.js';
import { bindCaptureSink } from '@dotli/metrics';
import type { ScheduledNotificationRecord } from '@dotli/storage';
import {
  createScheduledNotifications,
  type ScheduledNotificationsDeps,
  type ScheduledNotificationStore,
} from './scheduled-notifications.js';
import { FakePage } from '@dotli/shared/testing';

let page: FakePage;

const captures = { exception: vi.fn(), expected: vi.fn() };
bindCaptureSink(captures);

const closing = (): DOMException =>
  new DOMException(
    "Failed to execute 'transaction' on 'IDBDatabase': The database connection is closing.",
    'InvalidStateError',
  );

const due: ScheduledNotificationRecord = {
  hostId: 1,
  perProductId: 1,
  productId: 'acme.dot',
  title: 'Acme',
  text: 'x',
  deeplink: null,
  scheduledAt: 0,
};

/** Holds the given records, so a record removed once is gone for every later claim. */
function recordStore(records: ScheduledNotificationRecord[]) {
  const held = new Map(records.map(rec => [rec.hostId, rec]));
  return {
    schedule: vi.fn<ScheduledNotificationStore['schedule']>(),
    cancel: vi.fn<ScheduledNotificationStore['cancel']>(),
    allocateId: vi.fn<ScheduledNotificationStore['allocateId']>(),
    listAll: vi.fn<ScheduledNotificationStore['listAll']>(() => Promise.resolve([...held.values()])),
    removeStale: vi.fn<ScheduledNotificationStore['removeStale']>(() => Promise.resolve(0)),
    removeById: vi.fn<ScheduledNotificationStore['removeById']>(hostId => Promise.resolve(held.delete(hostId))),
  };
}

function start(store: ScheduledNotificationStore, deps: Partial<ScheduledNotificationsDeps> = {}) {
  const show = vi.fn<ScheduledNotificationsDeps['show']>();
  const notifications = createScheduledNotifications({
    store,
    show,
    // A lone tab always gets the lock.
    locks: {
      request: ((_name: string, _opts: unknown, run: (lock: object) => unknown) => run({})) as LockManager['request'],
    },
    openChannel: () => null,
    visibility: page,
    lifecycle: page,
    ...deps,
  });
  notifications.init({ label: 'acme' });
  return { notifications, show };
}

async function ticks(n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await vi.advanceTimersByTimeAsync(SCHEDULED_NOTIFICATIONS_POLL_INTERVAL_MS);
  }
}

describe('scheduled notifications poller', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    page = new FakePage();
    captures.exception.mockReset();
    captures.expected.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('As an operator, a connection that keeps closing leaves one breadcrumb, not an issue per tick', async () => {
    // Given a polling tab whose database connection starts closing
    const store = recordStore([{ ...due, scheduledAt: Date.now() + 3_600_000 }]);
    start(store);
    await ticks(1);
    store.removeStale.mockRejectedValue(closing());
    store.listAll.mockRejectedValue(closing());

    // When the poller ticks for several seconds
    await ticks(5);

    // Then each step records it once as expected, and nothing is captured
    expect(captures.exception).not.toHaveBeenCalled();
    expect(captures.expected).toHaveBeenCalledTimes(2);
    expect(captures.expected).toHaveBeenCalledWith(expect.any(DOMException), {
      flow: 'notifications',
      step: 'list_pending',
    });
  });

  it('As an operator, a tick the page unload catches reports nothing', async () => {
    // Given a polling tab
    const store = recordStore([{ ...due, scheduledAt: Date.now() + 3_600_000 }]);
    start(store);
    await ticks(1);

    // When the page hides while a tick is reading and the read then fails
    const read: PromiseWithResolvers<ScheduledNotificationRecord[]> = Promise.withResolvers();
    store.listAll.mockReturnValue(read.promise);
    await vi.advanceTimersByTimeAsync(SCHEDULED_NOTIFICATIONS_POLL_INTERVAL_MS);
    page.dispatchEvent(new Event('pagehide'));
    read.reject(closing());
    await ticks(3);

    // Then nothing is reported
    expect(captures.exception).not.toHaveBeenCalled();
    expect(captures.expected).not.toHaveBeenCalled();
  });

  it('As an operator, a claim that keeps failing is captured once, not left unhandled', async () => {
    // Given a due record whose claim fails
    const failure = new Error('disk gone');
    const store = recordStore([due]);
    store.removeById.mockRejectedValue(failure);

    // When the poller ticks for several seconds
    start(store);
    await ticks(5);

    // Then the failure is captured once, under the claim step
    expect(captures.exception).toHaveBeenCalledTimes(1);
    expect(captures.exception).toHaveBeenCalledWith(failure, { flow: 'notifications', step: 'claim' });
  });

  it('As a user, a due notification that the page load and the poller reach together shows once', async () => {
    // Given a due record whose claim at page load is slow to land
    const store = recordStore([due]);
    const removeRecord = store.removeById.getMockImplementation();
    const landed: PromiseWithResolvers<void> = Promise.withResolvers();
    store.removeById.mockImplementationOnce(async hostId => {
      await landed.promise;
      return (await removeRecord?.(hostId)) ?? false;
    });
    store.schedule.mockResolvedValue({ ok: true, id: 2 });
    // Without Web Locks, so nothing but the claim itself keeps the two apart.
    const { notifications, show } = start(store, { locks: undefined });

    // When a newly scheduled notification starts the poller, which reaches the record while that claim still runs
    await notifications.schedule({ ...due, scheduledAt: Date.now() + 3_600_000 });
    await ticks(2);
    landed.resolve();
    await ticks(1);

    // Then it shows once, as the page load found it
    expect(show).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledWith(expect.objectContaining({ label: 'Acme', browserNotification: false }));
  });
});
