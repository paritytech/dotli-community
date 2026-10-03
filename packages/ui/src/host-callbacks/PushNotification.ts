// Push-notification callback. The Rust core passes the typed request, and
// this adapter returns a stable host-side id for cancel support.
//
// The core authorizes `Notifications` (prompting through `devicePermission`
// and consuming a one-time grant) before it calls here, so this adapter does
// not prompt or re-check: a second check would find a consumed "Allow once"
// gone and prompt the user again.

import type { Notifications } from '@parity/truapi-host';
import { log } from '@dotli/shared';
import { cancelNotification, scheduleNotification } from '../scheduled-notifications.js';
import { showNotification } from '../notification.js';
import { ERRORS } from '../errors.js';

export function createNotificationAdapters(label: string): Required<Notifications> {
  const pushNotification: Required<Notifications>['pushNotification'] = async ({ text, deeplink, scheduledAt }) => {
    // Facts only: the text and deeplink are the product's content for the user.
    log.event('push notification', { flow: 'notifications', scheduled: scheduledAt !== undefined });

    const result = await scheduleNotification({
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
      showNotification({ text, deeplink, label });
    }
    return { id: result.id };
  };

  const cancelPushNotification: Required<Notifications>['cancelNotification'] = async id => {
    await cancelNotification(label, id);
  };

  return { pushNotification, cancelNotification: cancelPushNotification };
}
