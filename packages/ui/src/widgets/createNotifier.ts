// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createReporter, defineCount } from '@dotli/metrics';
import { realTimers, type Timers } from '@dotli/shared';
import { toasts, type createToasts, type ToastInput } from '../page/state/createToasts.js';
import type { StatusTone } from '../page/statusTone.js';

const report = createReporter({ flow: 'ui' });

/** A system notification the browser refused to build although its permission was granted. */
const systemNotificationMetric = defineCount<'error'>('notification.system');

type NoticeTone = Exclude<StatusTone, 'quiet'>;

/** A toast's own fields, with a narrower tone and defaults for the dismiss time and the system notification. */
export type NotificationParams = Omit<ToastInput, 'tone' | 'dismissMs'> & {
  /** Info by default. */
  tone?: NoticeTone;
  /** 0 keeps it until closed. */
  dismissMs?: number;
  /** Also fire a browser Notification when the page is not attended. Default true. */
  browserNotification?: boolean;
};

/** The browser's system notification API. */
export type SystemNotifications = typeof Notification;

type Params = {
  /** The toast stack that shows each notification in the page. */
  toasts: Pick<ReturnType<typeof createToasts>, 'push'>;
  /**
   * Whether the user is looking at the page: the tab showing and its window focused. A window behind other windows
   * still reports visible, so focus decides there. An unattended page also gets a system notification.
   */
  attended: () => boolean;
  /** Undefined where the browser has none. */
  system: () => SystemNotifications | undefined;
  /** The window a click on a system notification brings forward and opens the link from. */
  page: Pick<Window, 'focus' | 'open'>;
  /** The page's own by default. A system notification closes on them. */
  timers?: Timers | undefined;
};

type FireBrowserNotificationParams = {
  /** The browser's notification API, which builds each system notification. */
  notifications: SystemNotifications;
  /** The notification with its text and link already cleaned. */
  notice: Pick<NotificationParams, 'label' | 'text' | 'deeplink'>;
  /** The window a click brings forward and opens the link from. */
  page: Params['page'];
  /** What the notification closes on after its time on screen. */
  timers: Timers;
};

export type ShowNotification = ReturnType<typeof createNotifier>;

const NOTIFICATION_DISMISS_MS = 10_000;

/** How long a system notification stays before it closes itself. */
const SYSTEM_NOTIFICATION_MS = 5000;

/**
 * Builds a notifier that shows each notification through `toasts`, and through `system` too while `attended` says
 * no one is looking. Returns the notify function.
 */
export function createNotifier({ toasts, attended, system, page, timers = realTimers }: Params) {
  /**
   * Shows a toast, and a system notification too while the page is not attended. Without the system's permission the
   * toast waits in the page until closed. The permission is the caller's to ask for. The label is the system
   * notification's title. Trims the text and cuts it to 200 characters, drops a notification whose text is blank, and
   * drops a link that is not http or https.
   */
  function notify({
    browserNotification = true,
    dismissMs = NOTIFICATION_DISMISS_MS,
    ...shown
  }: NotificationParams): void {
    const text = shown.text.trim().slice(0, 200);
    if (!text) {
      return;
    }
    const notice = { ...shown, text, deeplink: validateDeeplink(shown.deeplink) };
    const wantsSystem = browserNotification && !attended();
    const notifications = wantsSystem ? system() : undefined;
    const systemShown =
      notifications?.permission === 'granted' && fireBrowserNotification({ notifications, notice, page, timers });
    // One the system did not show stays in the page until closed, or a window behind others would lose it unseen.
    const fallback = wantsSystem && !systemShown;

    toasts.push({ ...notice, dismissMs: fallback ? 0 : dismissMs });
  }

  return notify;
}

/** The page's notifier over the toast store. */
export const showNotification = createNotifier({
  toasts,
  // Focus inside the product's frame still counts, since the top document's focus covers its frames.
  attended: () => document.visibilityState === 'visible' && document.hasFocus(),
  system: () => ('Notification' in window ? window.Notification : undefined),
  // The window in a page, read without naming it so the module still loads where there is none.
  page: globalThis,
});

function validateDeeplink(deeplink: string | undefined): string | undefined {
  if (deeplink === undefined) {
    return undefined;
  }
  try {
    const url = new URL(deeplink);
    return url.protocol === 'https:' || url.protocol === 'http:' ? deeplink : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Shows a system notification and returns whether it showed. A browser may grant the permission and still refuse to
 * build one, as Chrome on Android does outside a service worker.
 */
function fireBrowserNotification({
  notifications: SystemNotification,
  notice: { label, text, deeplink },
  page,
  timers,
}: FireBrowserNotificationParams): boolean {
  let notification: Notification;
  try {
    notification = new SystemNotification(label, { body: text });
  } catch (error) {
    report.expected(error, { step: 'system_notification', metric: systemNotificationMetric });
    return false;
  }
  notification.onclick = () => {
    page.focus();
    if (deeplink !== undefined) {
      page.open(deeplink, '_blank');
    }
  };
  timers.setTimeout(() => {
    notification.close();
  }, SYSTEM_NOTIFICATION_MS);
  return true;
}
