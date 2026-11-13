// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The `Notifications` authorization is the core's, so this adapter never checks it: a second check would find a
// consumed "Allow once" gone and prompt the user again.

import type { Notifications } from '@parity/truapi-host';
import type { HostPushNotificationRequest, HostPushNotificationResponse, ProductId } from '@parity/truapi';
import { createReporter } from '@dotli/metrics';
import type { ScheduledNotifications } from '../createScheduledNotifications.js';
import { ERRORS } from '../errors.js';
import type { HostPrompts } from '../hostPrompts.js';

const report = createReporter({ flow: 'notifications' });

/** Where a product's notifications wait until they are due. */
export type NotificationScheduler = Pick<ScheduledNotifications, 'schedule' | 'cancel'>;

type Params = {
  /** The product the notifications come from, which titles them. */
  label: string;
  /**
   * The id the notifications are kept under, the full one with its network, so a label on two networks keeps two
   * queues. Throws until the core has parsed it.
   */
  getProductId: () => ProductId;
  /** Where a notification waits until it is due. */
  scheduler: NotificationScheduler;
  /** Shows a due notification on the page. */
  notify: HostPrompts['notify'];
};

/**
 * Schedules the product's push notifications and shows a due one at once. A push rejects when the product has reached
 * its schedule limit. A push or cancel rejects before the core has parsed the product's id, and touches nothing.
 */
export function createNotificationAdapters({
  label,
  getProductId,
  scheduler,
  notify,
}: Params): Required<Notifications> {
  async function pushNotification({
    text,
    deeplink,
    scheduledAt,
  }: HostPushNotificationRequest): Promise<HostPushNotificationResponse> {
    const productId = getProductId();
    // The text and deeplink are the user's content, so they stay out of the log.
    report.log.event('push notification', { scheduled: scheduledAt !== undefined });

    const result = await scheduler.schedule({
      productId,
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
    await scheduler.cancel(getProductId(), id);
  }

  return { pushNotification, cancelNotification };
}
