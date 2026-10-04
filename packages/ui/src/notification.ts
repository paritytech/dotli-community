// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// dot.li Notification display
//
// Stackable toasts, rendered by the overlays root (components/overlays/
// ToastStack.tsx) from the toast store. Auto-dismiss pauses while the tab is
// hidden or the stack is expanded. Optionally fires the browser Notification
// API when the tab is hidden; that part does not depend on the overlays.

import { presentToast } from './overlays/load.js';
import type { StatusTone } from './components/primitives/StatusDot.js';

/** Default auto-dismiss delay in ms. */
export const NOTIFICATION_DISMISS_MS = 10_000;

const ALERT_PATHS =
  '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>' +
  '<path d="M12 9v4"/><path d="M12 17h.01"/>';

const TONE_ICON_PATHS: Record<StatusTone, string> = {
  info: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  ok: '<path d="M20 6 9 17l-5-5"/>',
  warn: ALERT_PATHS,
  err: ALERT_PATHS,
  idle: '<circle cx="12" cy="12" r="10"/><path d="m4.93 4.93 14.14 14.14"/>',
};

/** The tone's own icon, stroked in currentColor so the tile's tone colours it. */
function toneIcon(tone: StatusTone): string {
  return (
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    TONE_ICON_PATHS[tone] +
    '</svg>'
  );
}

export interface NotificationParams {
  text: string;
  label: string;
  deeplink?: string | undefined;
  /** SVG string for the icon, stroked in currentColor to take the tone. Default: the tone's own icon. */
  icon?: string;
  /** What the notification reports, which tints its icon tile. Default: info. */
  tone?: StatusTone;
  /** Auto-dismiss in ms. 0 = persistent (manual close only). Default: NOTIFICATION_DISMISS_MS. */
  dismissMs?: number;
  /** Send browser Notification API when the tab is hidden. Default: true. */
  browserNotification?: boolean;
  /** Called when the notification is dismissed (user close or auto-dismiss). */
  onDismiss?: () => void;
  /** Optional action button rendered next to the text area. */
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

// Browser Notification, used as a supplement when the tab is hidden.
function fireBrowserNotification(text: string, deeplink: string | undefined, label: string): void {
  if (!('Notification' in window)) {
    return;
  }

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

export function showNotification(params: NotificationParams): void {
  const text = sanitizeText(params.text);
  if (!text) {
    return;
  }
  const deeplink = validateDeeplink(params.deeplink);
  const tone = params.tone ?? 'info';

  presentToast({
    text,
    label: params.label,
    icon: params.icon ?? toneIcon(tone),
    tone,
    dismissMs: params.dismissMs ?? NOTIFICATION_DISMISS_MS,
    ...(deeplink === undefined ? {} : { deeplink }),
    ...(params.onDismiss === undefined ? {} : { onDismiss: params.onDismiss }),
    ...(params.action === undefined ? {} : { action: params.action }),
  });

  if ((params.browserNotification ?? true) && document.visibilityState !== 'visible') {
    fireBrowserNotification(text, deeplink, params.label);
  }
}
