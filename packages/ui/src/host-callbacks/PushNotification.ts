// The core authorizes `Notifications` before calling here, so this adapter must not re-check:
// a second check would find a consumed "Allow once" gone and prompt the user again.

import type { Notifications } from '@parity/truapi-host';
import { log } from '@dotli/shared';
import { cancelNotification, scheduleNotification } from '../scheduled-notifications.js';
import { showNotification } from '../notification.js';
import { ERRORS } from '../errors.js';

export function createNotificationAdapters(label: string): Required<Notifications> {
  const pushNotification: Required<Notifications>['pushNotification'] = async ({ text, deeplink, scheduledAt }) => {
    // The text and deeplink are the user's content, so they stay out of the log.
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

  return {
    pushNotification,
    cancelNotification: cancelPushNotification,
    // Browser notifications navigate directly, without an account-bound activation queue.
    activationEvents() {
      return Promise.reject(new Error('Notification activation queues are not supported by this browser host'));
    },
    acknowledgeActivation() {
      return Promise.reject(new Error('Notification activation queues are not supported by this browser host'));
    },
  };
}
