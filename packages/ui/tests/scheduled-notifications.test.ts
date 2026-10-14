// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SCHEDULED_NOTIFICATIONS_POLL_INTERVAL_MS } from '@dotli/config';
import type * as Storage from '@dotli/storage';
import type * as Metrics from '@dotli/metrics';

const storage = vi.hoisted(() => ({
  listAll: vi.fn<() => Promise<Storage.ScheduledNotificationRecord[]>>(),
  removeStale: vi.fn<() => Promise<number>>(),
  removeById: vi.fn<() => Promise<boolean>>(),
}));
vi.mock('@dotli/storage', async importOriginal => ({
  ...(await importOriginal<typeof Storage>()),
  ...storage,
}));

const sentry = vi.hoisted(() => ({ captureException: vi.fn(), recordExpected: vi.fn() }));
vi.mock('@dotli/metrics', async importOriginal => ({
  ...(await importOriginal<typeof Metrics>()),
  ...sentry,
}));

// Every due record belongs to a live notification of the current account, so
// the poller reaches its claim.
vi.mock('@dotli/storage/notification-activations', () => ({
  findNotification: vi.fn(() => Promise.resolve({ scope: {} })),
}));
vi.mock('../src/notification-activation.js', () => ({
  notificationContextIsCurrent: () => true,
  presentProductNotification: vi.fn(() => Promise.resolve()),
}));

const closing = (): DOMException =>
  new DOMException(
    "Failed to execute 'transaction' on 'IDBDatabase': The database connection is closing.",
    'InvalidStateError',
  );

const due: Storage.ScheduledNotificationRecord = {
  hostId: 1,
  perProductId: 1,
  productId: 'acme.dot',
  title: 'Acme',
  text: 'x',
  deeplink: null,
  scheduledAt: 0,
};

async function ticks(n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await vi.advanceTimersByTimeAsync(SCHEDULED_NOTIFICATIONS_POLL_INTERVAL_MS);
  }
}

// The runtime keeps module state, so each test loads a fresh copy.
async function start(): Promise<void> {
  vi.resetModules();
  const { initScheduledNotifications } = await import('../src/scheduled-notifications.js');
  initScheduledNotifications({ label: 'acme' });
}

describe('scheduled notifications poller', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sentry.captureException.mockReset();
    sentry.recordExpected.mockReset();
    storage.removeStale.mockResolvedValue(0);
    storage.removeById.mockResolvedValue(true);
    storage.listAll.mockResolvedValue([{ ...due, scheduledAt: Date.now() + 3_600_000 }]);
    // happy-dom has `navigator.locks` but leaves it null. A lone tab always gets the lock.
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: { request: (_name: string, _opts: unknown, run: (lock: object) => unknown) => run({}) },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('As an operator, a connection that keeps closing leaves one breadcrumb, not an issue per tick', async () => {
    // Given a polling tab whose database connection starts closing
    await start();
    await ticks(1);
    storage.removeStale.mockRejectedValue(closing());
    storage.listAll.mockRejectedValue(closing());

    // When the poller ticks for several seconds
    await ticks(5);

    // Then each step records it once as expected, and nothing is captured
    expect(sentry.captureException).not.toHaveBeenCalled();
    expect(sentry.recordExpected).toHaveBeenCalledTimes(2);
    expect(sentry.recordExpected).toHaveBeenCalledWith(expect.any(DOMException), {
      flow: 'notifications',
      step: 'list_pending',
    });
  });

  it('As an operator, a tick the page unload catches reports nothing', async () => {
    // Given a polling tab
    await start();
    await ticks(1);

    // When the page hides while a tick is reading and the read then fails
    let failRead: (err: unknown) => void = () => undefined;
    storage.listAll.mockReturnValue(
      new Promise((_resolve, reject) => {
        failRead = reject;
      }),
    );
    await vi.advanceTimersByTimeAsync(SCHEDULED_NOTIFICATIONS_POLL_INTERVAL_MS);
    window.dispatchEvent(new Event('pagehide'));
    failRead(closing());
    await ticks(3);

    // Then nothing is reported
    expect(sentry.captureException).not.toHaveBeenCalled();
    expect(sentry.recordExpected).not.toHaveBeenCalled();
  });

  it('As an operator, a claim that keeps failing is captured once, not left unhandled', async () => {
    // Given a due record whose claim fails
    const failure = new Error('disk gone');
    storage.listAll.mockResolvedValue([due]);
    storage.removeById.mockRejectedValue(failure);

    // When the poller ticks for several seconds
    await start();
    await ticks(5);

    // Then the failure is captured once, under the claim step
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    expect(sentry.captureException).toHaveBeenCalledWith(failure, { flow: 'notifications', step: 'claim' });
  });
});
