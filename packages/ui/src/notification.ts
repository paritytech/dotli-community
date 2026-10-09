// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { presentToast } from './overlays/load.js';
import { dismissToast } from './state/toasts.js';
import type { StatusTone } from './components/primitives/StatusDot.js';

type NoticeTone = Exclude<StatusTone, 'quiet'>;

export const NOTIFICATION_DISMISS_MS = 10_000;

const ALERT_PATHS =
  '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0zM12 9v4m0 4h.01"/>';

const TONE_ICON_PATHS: Record<NoticeTone, string> = {
  info: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9m4.3 13a1.94 1.94 0 0 0 3.4 0"/>',
  ok: '<path d="M20 6 9 17l-5-5"/>',
  warn: ALERT_PATHS,
  err: ALERT_PATHS,
  idle: '<circle cx="12" cy="12" r="10"/><path d="m4.93 4.93 14.14 14.14"/>',
};

/** Stroked in currentColor so the tile's tone colours it. */
function toneIcon(tone: NoticeTone): string {
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
  /** Host-owned activation handler. Product callbacks never supply executable code. */
  onActivate?: () => void;
  /** SVG stroked in currentColor to take the tone. */
  icon?: string;
  tone?: NoticeTone;
  /** 0 keeps it until closed. */
  dismissMs?: number;
  /** Send browser Notification API when the tab is hidden or unfocused. Default: true. */
  browserNotification?: boolean;
  onDismiss?: () => void;
  action?: { label: string; onClick: () => void };
}

function sanitizeText(raw: string): string {
  return raw.trim().slice(0, 200);
}

function notificationActivation(params: NotificationParams): (() => void) | undefined {
  if (params.onActivate) {
    return params.onActivate;
  }
  let url: URL | undefined;
  if (params.deeplink !== undefined && params.deeplink.trim() !== '') {
    try {
      url = new URL(params.deeplink);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        return undefined;
      }
      if (url.username !== '' || url.password !== '') {
        return undefined;
      }
    } catch {
      return undefined;
    }
  }
  if (url === undefined) {
    return undefined;
  }
  return () => {
    window.focus();
    window.open(url.href, '_blank', 'noopener');
  };
}

// Browser Notification, used as a supplement when the tab is hidden or unfocused.
function fireBrowserNotification(text: string, activate: (() => void) | undefined, label: string): void {
  if (!('Notification' in window)) {
    return;
  }

  const show = (): void => {
    const n = new Notification(label, { body: text });
    n.onclick = () => {
      if (activate) {
        activate();
      } else {
        window.focus();
      }
      n.close();
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

export function showNotification(params: NotificationParams): () => void {
  const text = sanitizeText(params.text);
  if (!text) {
    return () => undefined;
  }
  const onActivate = notificationActivation(params);
  const tone = params.tone ?? 'info';

  const id = presentToast({
    text,
    label: params.label,
    icon: params.icon ?? toneIcon(tone),
    tone,
    dismissMs: params.dismissMs ?? NOTIFICATION_DISMISS_MS,
    ...(onActivate === undefined ? {} : { onActivate }),
    ...(params.onDismiss === undefined ? {} : { onDismiss: params.onDismiss }),
    ...(params.action === undefined ? {} : { action: params.action }),
  });

  if ((params.browserNotification ?? true) && (document.visibilityState !== 'visible' || !document.hasFocus())) {
    fireBrowserNotification(text, onActivate, params.label);
  }
  return () => {
    dismissToast(id);
  };
}
