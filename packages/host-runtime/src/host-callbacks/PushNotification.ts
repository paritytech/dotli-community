// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The core authorizes `Notifications` before calling here, so this adapter must not re-check:
// a second check would find a consumed "Allow once" gone and prompt the user again.

import type { Notifications } from '@parity/truapi-host';
import { log } from '@dotli/shared';
import type { ScheduledNotifications } from '../scheduled-notifications.js';
import { ERRORS } from '../errors.js';
import type { HostPrompts } from '../host-prompts.js';

export type NotificationScheduler = Pick<ScheduledNotifications, 'schedule' | 'cancel'>;

/** Shows a notification on the page. */
export type Notify = HostPrompts['notify'];

export function createNotificationAdapters(
  label: string,
  scheduler: NotificationScheduler,
  notify: Notify,
): Required<Notifications> {
  const pushNotification: Required<Notifications>['pushNotification'] = async ({ text, deeplink, scheduledAt }) => {
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
  };

  const cancelPushNotification: Required<Notifications>['cancelNotification'] = async id => {
    await scheduler.cancel(label, id);
  };

  return { pushNotification, cancelNotification: cancelPushNotification };
}
