// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The `Notifications` authorization is the core's, so this adapter never checks it: a second check would find a
// consumed "Allow once" gone and prompt the user again.

import type { Notifications } from '@parity/truapi-host';
import type { HostPushNotificationRequest, HostPushNotificationResponse } from '@parity/truapi';
import { log } from '@dotli/shared';
import type { ScheduledNotifications } from '../scheduledNotifications.js';
import { ERRORS } from '../errors.js';
import type { HostPrompts } from '../hostPrompts.js';

/** Where a product's notifications wait until they are due. */
export type NotificationScheduler = Pick<ScheduledNotifications, 'schedule' | 'cancel'>;

/** Shows a notification on the page. */
export type Notify = HostPrompts['notify'];

type Params = {
  /** The product the notifications come from. */
  label: string;
  /** Where a notification waits until it is due. */
  scheduler: NotificationScheduler;
  /** Shows a due notification on the page. */
  notify: Notify;
};

/**
 * Schedules the product's push notifications and shows a due one at once. A push rejects when the product has reached
 * its schedule limit.
 */
export function createNotificationAdapters({ label, scheduler, notify }: Params): Required<Notifications> {
  async function pushNotification({
    text,
    deeplink,
    scheduledAt,
  }: HostPushNotificationRequest): Promise<HostPushNotificationResponse> {
    // The text and deeplink are the user's content, so they stay out of the log.
    log.event('push notification', { flow: 'notifications', scheduled: scheduledAt !== undefined });

    const result = await scheduler.schedule({
      productId: label,
      title: label,
      text,
      deeplink: deeplink ?? null,
      scheduledAt: scheduledAt === undefined ? null : Number(scheduledAt),
    });
    if (!result.ok) {
      throw new Error(ERRORS.SCHEDULE_LIMIT_REACHED);
    }

    if (result.immediate) {
      notify({ text, deeplink, label });
    }
    return { id: result.id };
  }

  async function cancelNotification(id: number): Promise<void> {
    await scheduler.cancel(label, id);
  }

  return { pushNotification, cancelNotification };
}
