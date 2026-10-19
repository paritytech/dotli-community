// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Component } from 'solid-js';
import type { IconProps } from '../components/icons/icon-props.js';
import { pushToast, type ToastInput } from '../page/state/toasts.js';
import type { StatusTone } from '../page/status-tone.js';

type NoticeTone = Exclude<StatusTone, 'quiet'>;

export const NOTIFICATION_DISMISS_MS = 10_000;

export interface NotificationParams {
  text: string;
  label: string;
  deeplink?: string | undefined;
  /** Drawn in currentColor, so it takes the tone. The tone's own icon without one, chosen when the toast renders. */
  icon?: Component<IconProps>;
  tone?: NoticeTone;
  /** 0 keeps it until closed. */
  dismissMs?: number;
  /** Also fire a browser Notification when the page is not attended. Default true. */
  browserNotification?: boolean;
  onDismiss?: () => void;
  action?: { label: string; onClick: () => void };
}

function sanitizeText(raw: string): string {
  return raw.trim().slice(0, 200);
}

function validateDeeplink(dl: string | undefined): string | undefined {
  if (dl === undefined || dl === '') {
    return undefined;
  }
  try {
    const u = new URL(dl);
    return u.protocol === 'https:' || u.protocol === 'http:' ? dl : undefined;
  } catch {
    return undefined;
  }
}

/** The browser's system notification API. */
export type SystemNotifications = typeof Notification;

function fireBrowserNotification(
  Notification: SystemNotifications,
  text: string,
  deeplink: string | undefined,
  label: string,
): void {
  const show = (): void => {
    const n = new Notification(label, { body: text });
    n.onclick = () => {
      window.focus();
      if (deeplink !== undefined && deeplink !== '') {
        window.open(deeplink, '_blank');
      }
    };
    setTimeout(() => {
      n.close();
    }, 5000);
  };

  if (Notification.permission === 'granted') {
    show();
  } else if (Notification.permission !== 'denied') {
    void Notification.requestPermission().then(p => {
      if (p === 'granted') {
        show();
      }
    });
  }
}

export interface NotifierDeps {
  present: (input: ToastInput) => void;
  /**
   * Whether the user is looking at the page: the tab showing and its window focused. A window behind other windows
   * still reports visible, so focus decides there. An unattended page also gets a system notification.
   */
  attended: () => boolean;
  /** Undefined where the browser has none. */
  system: () => SystemNotifications | undefined;
}

/** Shows a toast, and a system notification too while the page is not attended. */
export type ShowNotification = (params: NotificationParams) => void;

export function createNotifier({ present, attended, system }: NotifierDeps): ShowNotification {
  return params => {
    const text = sanitizeText(params.text);
    if (!text) {
      return;
    }
    const deeplink = validateDeeplink(params.deeplink);
    const tone = params.tone ?? 'info';

    present({
      text,
      label: params.label,
      ...(params.icon === undefined ? {} : { icon: params.icon }),
      tone,
      dismissMs: params.dismissMs ?? NOTIFICATION_DISMISS_MS,
      ...(deeplink === undefined ? {} : { deeplink }),
      ...(params.onDismiss === undefined ? {} : { onDismiss: params.onDismiss }),
      ...(params.action === undefined ? {} : { action: params.action }),
    });

    const notifications = (params.browserNotification ?? true) && !attended() ? system() : undefined;
    if (notifications !== undefined) {
      fireBrowserNotification(notifications, text, deeplink, params.label);
    }
  };
}

/** The page's notifier over the toast store. */
export const showNotification: ShowNotification = createNotifier({
  present: input => {
    pushToast(input);
  },
  // Focus inside the product's frame still counts, since the top document's focus covers its frames.
  attended: () => document.visibilityState === 'visible' && document.hasFocus(),
  system: () => ('Notification' in window ? window.Notification : undefined),
});
