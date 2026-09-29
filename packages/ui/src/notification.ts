// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// dot.li Notification display
//
// Stackable toasts, rendered by the overlays root (components/overlays/
// ToastStack.tsx) from the toast store. Auto-dismiss pauses while the tab is
// hidden or the stack is expanded. Optionally fires the browser Notification
// API when the tab is hidden; that part does not depend on the overlays.

import { presentToast } from "./overlays/load.js";

/** Default auto-dismiss delay in ms. */
export const NOTIFICATION_DISMISS_MS = 10_000;

const BELL_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>' +
  '<path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>';

export interface NotificationParams {
  text: string;
  label: string;
  deeplink?: string | undefined;
  /** SVG string for the icon. Default: bell. */
  icon?: string;
  /** CSS color for an icon background. Default: inherits from .notif-icon (#0a0a0a). */
  iconBackground?: string;
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
  if (dl === undefined || dl === "") {
    return undefined;
  }
  try {
    const u = new URL(dl);
    return u.protocol === "https:" || u.protocol === "http:" ? dl : undefined;
  } catch {
    return undefined;
  }
}

// Browser Notification, used as a supplement when the tab is hidden.
function fireBrowserNotification(
  text: string,
  deeplink: string | undefined,
  label: string,
): void {
  if (!("Notification" in window)) {
    return;
  }

  const show = (): void => {
    const n = new Notification(label, { body: text });
    n.onclick = () => {
      window.focus();
      if (deeplink !== undefined && deeplink !== "") {
        window.open(deeplink, "_blank");
      }
    };
    setTimeout(() => {
      n.close();
    }, 5000);
  };

  if (Notification.permission === "granted") {
    show();
  } else if (Notification.permission !== "denied") {
    void Notification.requestPermission().then((p) => {
      if (p === "granted") {
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

  presentToast({
    text,
    label: params.label,
    icon: params.icon ?? BELL_SVG,
    dismissMs: params.dismissMs ?? NOTIFICATION_DISMISS_MS,
    ...(deeplink === undefined ? {} : { deeplink }),
    ...(params.iconBackground === undefined || params.iconBackground === ""
      ? {}
      : { iconBackground: params.iconBackground }),
    ...(params.onDismiss === undefined ? {} : { onDismiss: params.onDismiss }),
    ...(params.action === undefined ? {} : { action: params.action }),
  });

  if (
    (params.browserNotification ?? true) &&
    document.visibilityState !== "visible"
  ) {
    fireBrowserNotification(text, deeplink, params.label);
  }
}
