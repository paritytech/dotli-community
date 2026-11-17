// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { asProductId } from '@parity/truapi';
import { ERRORS } from '../../../kit/errors.js';
import { createNotificationAdapters, type NotificationScheduler } from './createNotificationAdapters.js';

const PRODUCT_ID = asProductId('myapp.paseo');
function getProductId() {
  return PRODUCT_ID;
}

describe('notification host callbacks', () => {
  it('As a product developer, I push a notification that is due now and it is scheduled under my full product id with my label and answered with its id', async () => {
    // Given
    const { scheduler, schedule } = createFakeScheduler();
    const { pushNotification } = createNotificationAdapters({
      label: 'myapp',
      getProductId,
      scheduler,
    });

    // When
    const response = await pushNotification({
      text: 'hello',
    });

    // Then
    expect(response).toEqual({ id: 7 });
    expect(schedule).toHaveBeenCalledWith({
      productId: PRODUCT_ID,
      title: 'myapp',
      text: 'hello',
      deeplink: null,
      scheduledAt: null,
    });
  });

  it('As a product developer, I push or cancel a notification before the core parsed my product id and both reject without touching the scheduler', async () => {
    // Given a core that has not parsed the product id yet
    const { scheduler, schedule, cancel } = createFakeScheduler();
    const { pushNotification, cancelNotification } = createNotificationAdapters({
      label: 'myapp',
      getProductId: () => {
        throw new Error(ERRORS.PRODUCT_ID_NOT_READY);
      },
      scheduler,
    });

    // When
    const push = pushNotification({ text: 'hello' });
    const cancelled = cancelNotification(7);

    // Then
    await expect(push).rejects.toThrow(ERRORS.PRODUCT_ID_NOT_READY);
    await expect(cancelled).rejects.toThrow(ERRORS.PRODUCT_ID_NOT_READY);
    expect(schedule).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });

  it('As a product developer, I push a notification past the schedule limit and the push rejects', async () => {
    // Given
    const { scheduler, schedule } = createFakeScheduler();
    schedule.mockResolvedValue({ ok: false, error: 'ScheduleLimitReached' });
    const { pushNotification } = createNotificationAdapters({
      label: 'myapp',
      getProductId,
      scheduler,
    });

    // When
    const notification = pushNotification({
      text: 'hello',
    });

    // Then
    await expect(notification).rejects.toThrow('ScheduleLimitReached');
  });
});

/** A scheduler that answers each schedule with id 7, and each cancel as done. */
function createFakeScheduler(): {
  scheduler: NotificationScheduler;
  schedule: ReturnType<typeof vi.fn<NotificationScheduler['schedule']>>;
  cancel: ReturnType<typeof vi.fn<NotificationScheduler['cancel']>>;
} {
  const schedule = vi.fn<NotificationScheduler['schedule']>(() => Promise.resolve({ ok: true, id: 7 }));
  const cancel = vi.fn<NotificationScheduler['cancel']>(() => Promise.resolve(true));
  return { scheduler: { schedule, cancel }, schedule, cancel };
}
