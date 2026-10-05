// Push-notification callback. The Rust core passes the typed request, and
// this adapter returns a stable host-side id for cancel support.
//
// The core authorizes `Notifications` (prompting through `devicePermission`
// and consuming a one-time grant) before it calls here, so this adapter does
// not prompt or re-check: a second check would find a consumed "Allow once"
// gone and prompt the user again.

import type { Notifications } from '@parity/truapi-host';
import type { NotificationActivation } from '@parity/truapi';
import {
  retainNotification,
  findNotification,
  pendingNotificationActivations,
  acknowledgeNotificationActivation,
  cancelNotificationActivation,
  validNotificationRoute,
} from '@dotli/storage/notification-activations';
import { cancelNotification, scheduleNotification } from '../scheduled-notifications.js';
import {
  notificationContext,
  notificationContextIsCurrent,
  presentProductNotification,
} from '../notification-activation.js';
import { ERRORS } from '../errors.js';

export function createNotificationAdapters(label: string): Required<Notifications> {
  const pushNotification: Required<Notifications>['pushNotification'] = async ({ text, deeplink, scheduledAt }) => {
    const context = notificationContext(label);
    if (deeplink !== undefined && !validNotificationRoute(deeplink)) {
      throw new Error('Invalid notification destination');
    }

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

    try {
      await retainNotification({
        scope: context.scope,
        notificationId: result.id,
        entryUrl: context.target.entryUrl,
        route: deeplink ?? null,
        expiresAt: Math.max(Date.now(), Number(scheduledAt ?? 0)) + 7 * 24 * 60 * 60 * 1000,
      });
      if (!notificationContextIsCurrent(context.scope)) {
        throw new Error('Notification account changed');
      }
      if (result.immediate) {
        await presentProductNotification({ text, label, product: label, id: result.id });
      }
    } catch (error) {
      await cancelNotification(label, result.id);
      await cancelNotificationActivation(label, result.id);
      throw error;
    }
    return { id: result.id };
  };

  const cancelPushNotification: Required<Notifications>['cancelNotification'] = async id => {
    const context = notificationContext(label);
    const record = await findNotification(label, id);
    if (!record || !notificationContextIsCurrent(record.scope) || !notificationContextIsCurrent(context.scope)) {
      return;
    }
    await cancelNotificationActivation(label, id);
    await cancelNotification(label, id);
    const registration = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration('/') : undefined;
    const notifications = await registration?.getNotifications({ tag: `dotli:${record.token}` });
    for (const notification of notifications ?? []) {
      notification.close();
    }
  };

  return {
    pushNotification,
    cancelNotification: cancelPushNotification,
    // Browser enrollment belongs to the service-worker receiver, never this
    // resident wallet core. Each verified product connection installs its
    // immutable execution bridge in receiverCommand before opening a provider.
    receiverAuthority: () => Promise.resolve(undefined),
    receiverConsent: () => Promise.reject(new Error('Browser receiving consent requires the service-worker receiver')),
    receiverChanged: () => Promise.reject(new Error('Browser receiving state belongs to the service-worker receiver')),
    receiverCommand: () => Promise.resolve(undefined),
    activationEvents: async () => {
      // A click focuses one tab; background siblings must not route the same event.
      if (document.visibilityState !== 'visible' || !document.hasFocus()) {
        return { events: [] };
      }
      const { scope } = notificationContext(label);
      const records = await pendingNotificationActivations(scope);
      if (!notificationContextIsCurrent(scope)) {
        return { events: [] };
      }
      const events: NotificationActivation[] = [];
      for (const record of records) {
        if (record.route !== null) {
          events.push({
            sequence: BigInt(record.sequence),
            notificationId: record.notificationId,
            route: record.route,
          });
        }
      }
      return { events };
    },
    acknowledgeActivation: async ({ sequence }) => {
      if (sequence < 0n || sequence > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error('Invalid activation sequence');
      }
      const { scope } = notificationContext(label);
      await acknowledgeNotificationActivation(scope, Number(sequence));
    },
  };
}
