// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { createNotificationAdapters, type NotificationScheduler } from './createNotificationAdapters.js';
import type { NotificationParams } from '@dotli/ui';

describe('notification host callbacks', () => {
  it('As a product developer, I push a notification that is due now and it is scheduled, shown and answered with its id', async () => {
    // Given
    const { scheduler, schedule } = createFakeScheduler();
    const shown: NotificationParams[] = [];
    const { pushNotification } = createNotificationAdapters({
      label: 'myapp',
      scheduler,
      notify: params => {
        shown.push(params);
      },
    });

    // When
    const response = await pushNotification({
      text: 'hello',
    });

    // Then
    expect(response).toEqual({ id: 7 });
    expect(schedule).toHaveBeenCalledWith({
      productId: 'myapp',
      title: 'myapp',
      text: 'hello',
      deeplink: null,
      scheduledAt: null,
    });
    // A product cannot pick a tone, so its toasts read as info
    expect(shown).toEqual([{ text: 'hello', deeplink: undefined, label: 'myapp' }]);
  });

  it('As a product developer, I push a later notification and cancel it and both go through the shared scheduler', async () => {
    // Given
    const { scheduler, schedule, cancel } = createFakeScheduler();
    const { pushNotification, cancelNotification } = createNotificationAdapters({
      label: 'myapp',
      scheduler,
      notify: () => undefined,
    });

    // When
    await pushNotification({
      text: 'later',
      deeplink: 'dot://open',
      scheduledAt: 123n,
    });
    await cancelNotification(7);

    // Then
    expect(schedule).toHaveBeenCalledWith({
      productId: 'myapp',
      title: 'myapp',
      text: 'later',
      deeplink: 'dot://open',
      scheduledAt: 123,
    });
    expect(cancel).toHaveBeenCalledWith('myapp', 7);
  });

  it('As a product developer, I push a notification past the schedule limit and the push rejects', async () => {
    // Given
    const { scheduler, schedule } = createFakeScheduler();
    schedule.mockResolvedValue({ ok: false, error: 'ScheduleLimitReached' });
    const { pushNotification } = createNotificationAdapters({ label: 'myapp', scheduler, notify: () => undefined });

    // When
    const notification = pushNotification({
      text: 'hello',
    });

    // Then
    await expect(notification).rejects.toThrow('ScheduleLimitReached');
  });
});

/** A scheduler that answers each schedule with id 7, fired at once, and each cancel as done. */
function createFakeScheduler(): {
  scheduler: NotificationScheduler;
  schedule: ReturnType<typeof vi.fn<NotificationScheduler['schedule']>>;
  cancel: ReturnType<typeof vi.fn<NotificationScheduler['cancel']>>;
} {
  const schedule = vi.fn<NotificationScheduler['schedule']>(() =>
    Promise.resolve({ ok: true, id: 7, immediate: true }),
  );
  const cancel = vi.fn<NotificationScheduler['cancel']>(() => Promise.resolve(true));
  return { scheduler: { schedule, cancel }, schedule, cancel };
}
