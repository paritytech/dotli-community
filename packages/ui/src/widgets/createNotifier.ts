// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Component } from 'solid-js';
import { realTimers, type Timers } from '@dotli/shared';
import type { IconProps } from '../components/icons/iconProps.js';
import { toasts, type ToastInput } from '../page/state/createToasts.js';
import type { StatusTone } from '../page/statusTone.js';

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
  /** Shows the notification as a toast. */
  present: (input: ToastInput) => void;
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
  /** Opened in a new tab when the notification is clicked, none when undefined or empty. */
  deeplink: string | undefined;
  /** The notification's title. */
  label: string;
  /** What the notification closes on after its time on screen. */
  timers: Timers;
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
 * Builds a notifier that shows each notification through `present`, and through `system` too while `attended` says
 * no one is looking. Returns the notify function and never throws.
 */
export function createNotifier({ present, attended, system, timers = realTimers }: Params) {
  /**
   * Shows a toast, and a system notification too while the page is not attended. Without the system's permission the
   * toast waits in the page until closed. Drops a notification whose text is blank. Throws only what `present` throws.
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

    present({
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
      fireBrowserNotification({ notifications, text, deeplink, label: params.label, timers });
    }
  }

  return notify;
}

/** The page's notifier over the toast store. */
export const showNotification = createNotifier({
  present: input => {
    toasts.push(input);
  },
  // Focus inside the product's frame still counts, since the top document's focus covers its frames.
  attended: () => document.visibilityState === 'visible' && document.hasFocus(),
  system: () => ('Notification' in window ? window.Notification : undefined),
});

function sanitizeText(raw: string): string {
  return raw.trim().slice(0, 200);
}

function validateDeeplink(deeplink: string | undefined): string | undefined {
  if (deeplink === undefined || deeplink === '') {
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
}: FireBrowserNotificationParams): void {
  function show(): void {
    const notification = new SystemNotification(label, { body: text });
    notification.onclick = () => {
      window.focus();
      if (deeplink !== undefined && deeplink !== '') {
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
      void SystemNotification.requestPermission().then(permission => {
        if (permission === 'granted') {
          show();
        }
      });
      return;
  }
}
