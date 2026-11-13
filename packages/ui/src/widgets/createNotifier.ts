// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Component } from 'solid-js';
import { createReporter, defineCount } from '@dotli/metrics';
import { realTimers, type Timers } from '@dotli/shared';
import type { IconProps } from '../components/icons/iconProps.js';
import { toasts, type createToasts } from '../page/state/createToasts.js';
import type { StatusTone } from '../page/statusTone.js';

const report = createReporter({ flow: 'ui' });

/**
 * A permission request that failed, or a system notification that could not be shown after a late grant. Tagged
 * `outcome` (error) and `reason` (the error's name).
 */
const notificationSystemMetric = defineCount<'error'>('notification.system');

type NoticeTone = Exclude<StatusTone, 'quiet'>;

export type NotificationParams = {
  /** The message, trimmed and cut to 200 characters. A blank one drops the notification. */
  text: string;
  /** The title, which a system notification shows too. */
  label: string;
  /** An http or https link the notification opens. Any other value is dropped. */
  deeplink?: string | undefined;
  /** Drawn in currentColor, so it takes the tone. The tone's own icon without one, chosen when the toast renders. */
  icon?: Component<IconProps>;
  /** Info by default. */
  tone?: NoticeTone;
  /** 0 keeps it until closed. */
  dismissMs?: number;
  /** Also fire a browser Notification when the page is not attended. Default true. */
  browserNotification?: boolean;
  /** Runs once when the toast is dismissed. */
  onDismiss?: () => void;
  /** A button on the toast. */
  action?: { label: string; onClick: () => void };
};

/** The browser's system notification API. */
export type SystemNotifications = typeof Notification;

type Params = {
  /** The toast stack that shows each notification in the page. */
  toasts: Pick<ReturnType<typeof createToasts>, 'push' | 'setDismissMs'>;
  /**
   * Whether the user is looking at the page: the tab showing and its window focused. A window behind other windows
   * still reports visible, so focus decides there. An unattended page also gets a system notification.
   */
  attended: () => boolean;
  /** Undefined where the browser has none. */
  system: () => SystemNotifications | undefined;
  /** The page's own by default. A system notification closes on them. */
  timers?: Timers | undefined;
};

type FireBrowserNotificationParams = {
  /** The browser's notification API, which builds each system notification. */
  notifications: SystemNotifications;
  /** The notification's body. */
  text: string;
  /** Opened in a new tab when the notification is clicked, none when undefined. */
  deeplink: string | undefined;
  /** The notification's title. */
  label: string;
  /** What the notification closes on after its time on screen. */
  timers: Timers;
  /** Runs once the system notification is shown after a permission granted when asked. Never throws. */
  onShownOnGrant: () => void;
};

/**
 * Shows a toast, and a system notification too while the page is not attended. Without the system's permission the
 * toast waits in the page until closed.
 */
export type ShowNotification = ReturnType<typeof createNotifier>;

export const NOTIFICATION_DISMISS_MS = 10_000;

/** How long a system notification stays before it closes itself. */
const SYSTEM_NOTIFICATION_MS = 5000;

/**
 * Builds a notifier that shows each notification through `toasts`, and through `system` too while `attended` says
 * no one is looking. Returns the notify function.
 */
export function createNotifier({ toasts, attended, system, timers = realTimers }: Params) {
  /**
   * Shows a toast, and a system notification too while the page is not attended. Without the system's permission the
   * toast waits in the page until closed. A permission granted when asked gives the toast its usual time. Drops a
   * notification whose text is blank. Throws only what the system notification throws when built under a permission
   * already granted.
   */
  function notify(params: NotificationParams): void {
    const text = sanitizeText(params.text);
    if (!text) {
      return;
    }
    const deeplink = validateDeeplink(params.deeplink);
    const tone = params.tone ?? 'info';
    const wantsSystem = (params.browserNotification ?? true) && !attended();
    const notifications = wantsSystem ? system() : undefined;
    // One the system cannot show stays in the page until closed, or a window behind others would lose it unseen.
    const fallback = wantsSystem && notifications?.permission !== 'granted';

    const id = toasts.push({
      text,
      label: params.label,
      ...(params.icon === undefined ? {} : { icon: params.icon }),
      tone,
      dismissMs: fallback ? 0 : (params.dismissMs ?? NOTIFICATION_DISMISS_MS),
      ...(deeplink === undefined ? {} : { deeplink }),
      ...(params.onDismiss === undefined ? {} : { onDismiss: params.onDismiss }),
      ...(params.action === undefined ? {} : { action: params.action }),
    });

    if (notifications !== undefined) {
      fireBrowserNotification({
        notifications,
        text,
        deeplink,
        label: params.label,
        timers,
        onShownOnGrant: () => {
          toasts.setDismissMs(id, params.dismissMs ?? NOTIFICATION_DISMISS_MS);
        },
      });
    }
  }

  return notify;
}

/** The page's notifier over the toast store. */
export const showNotification = createNotifier({
  toasts,
  // Focus inside the product's frame still counts, since the top document's focus covers its frames.
  attended: () => document.visibilityState === 'visible' && document.hasFocus(),
  system: () => ('Notification' in window ? window.Notification : undefined),
});

function sanitizeText(raw: string): string {
  return raw.trim().slice(0, 200);
}

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

function fireBrowserNotification({
  notifications: SystemNotification,
  text,
  deeplink,
  label,
  timers,
  onShownOnGrant,
}: FireBrowserNotificationParams): void {
  function show(): void {
    const notification = new SystemNotification(label, { body: text });
    notification.onclick = () => {
      window.focus();
      if (deeplink !== undefined) {
        window.open(deeplink, '_blank');
      }
    };
    timers.setTimeout(() => {
      notification.close();
    }, SYSTEM_NOTIFICATION_MS);
  }

  switch (SystemNotification.permission) {
    case 'granted':
      show();
      return;
    case 'denied':
      return;
    case 'default':
      void SystemNotification.requestPermission()
        .then(permission => {
          if (permission === 'granted') {
            show();
            onShownOnGrant();
          }
        })
        .catch((error: unknown) => {
          report.expected(error, { step: 'system_notification', metric: notificationSystemMetric });
        });
      return;
  }
}
