// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { getNetwork } from '@dotli/config';
import {
  activateNotification,
  findNotification,
  sameNotificationScope,
  type NotificationRecord,
  type NotificationScope,
} from '@dotli/storage/notification-activations';
import { showNotification } from './notification.js';

export interface ProductNotificationTarget {
  artifact: string;
  entryUrl: string;
  isActive: () => boolean;
  focus: () => void;
}

const targets = new Map<string, ProductNotificationTarget>();
const accounts = new Map<string, string>();
let hostSession: { account: string; network: string } | undefined;

/** Only the current page core may publish resident delivery authority. */
export function setNotificationHostAccount(account: string | undefined): void {
  const normalized = account?.replace(/^0x/, '').toLowerCase();
  hostSession =
    normalized !== undefined && /^[0-9a-f]{64}$/.test(normalized)
      ? { account: normalized, network: getNetwork() }
      : undefined;
}

/** Only the core's live auth callback may supply this, never the UI-state cache. */
export function setNotificationAccount(label: string, account: string | undefined): void {
  const normalized = account?.replace(/^0x/, '').toLowerCase();
  if (normalized !== undefined && /^[0-9a-f]{64}$/.test(normalized)) {
    accounts.set(label, normalized);
  } else {
    accounts.delete(label);
  }
}

window.addEventListener('dotli:logged-out', () => {
  accounts.clear();
  hostSession = undefined;
});

export function registerProductNotificationTarget(label: string, target: ProductNotificationTarget): () => void {
  targets.set(label, target);
  return () => {
    if (targets.get(label) === target) {
      targets.delete(label);
    }
  };
}

export function notificationContext(label: string): { scope: NotificationScope; target: ProductNotificationTarget } {
  const target = targets.get(label);
  const account = accounts.get(label);
  if (target?.isActive() !== true || account === undefined || account.length === 0) {
    throw new Error('Notification activation requires a connected product and authenticated account');
  }
  return { target, scope: { product: label, account, network: getNetwork(), artifact: target.artifact } };
}

export function notificationContextIsCurrent(scope: NotificationScope): boolean {
  try {
    return sameNotificationScope(scope, notificationContext(scope.product).scope);
  } catch {
    return false;
  }
}

/** The durable record owns the original artifact; live auth owns presentation. */
export function notificationDeliveryIsCurrent(scope: NotificationScope): boolean {
  const target = targets.get(scope.product);
  return (
    hostSession?.account === scope.account &&
    hostSession.network === scope.network &&
    scope.network === getNetwork() &&
    (target === undefined || target.artifact === scope.artifact)
  );
}

/** A typed callback receives routes through polling; clicks never navigate its iframe. */
export async function presentProductNotification(params: {
  product: string;
  id: number;
  text: string;
  label: string;
  browserNotification?: boolean;
}): Promise<void> {
  const record = await findNotification(params.product, params.id);
  if (!record || record.expiresAt <= Date.now() || !notificationDeliveryIsCurrent(record.scope)) {
    return;
  }
  const activate = (): void => {
    if (!notificationDeliveryIsCurrent(record.scope)) {
      return;
    }
    void activateNotification(record.token)
      .then(activated => {
        if (activated && notificationDeliveryIsCurrent(record.scope)) {
          if (notificationContextIsCurrent(record.scope)) {
            notificationContext(params.product).target.focus();
          } else {
            // Keep the route pending until its verified product is mounted.
            window.focus();
          }
        }
      })
      .catch((error: unknown) => {
        console.error('[notifications] Could not retain activation', error);
      });
  };
  showNotification({ text: params.text, label: params.label, onActivate: activate, browserNotification: false });
  if (params.browserNotification === false || (document.visibilityState === 'visible' && document.hasFocus())) {
    return;
  }
  void presentSystemNotification(record, params.label, params.text).catch((error: unknown) => {
    // OS permission/delivery supplements the toast; it must not block IDs or the scheduler.
    console.warn('[notifications] System notification unavailable; in-page notification retained', error);
  });
}

async function presentSystemNotification(record: NotificationRecord, label: string, text: string): Promise<void> {
  if (!('Notification' in window) || !('serviceWorker' in navigator)) {
    return;
  }
  const permission =
    Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
  if (permission !== 'granted' || !notificationDeliveryIsCurrent(record.scope)) {
    return;
  }
  const registration = await navigator.serviceWorker.getRegistration('/');
  if (!registration?.active) {
    return;
  }
  const retained = await findNotification(record.scope.product, record.notificationId);
  if (
    retained?.token !== record.token ||
    retained.activated ||
    retained.acknowledged ||
    retained.expiresAt <= Date.now() ||
    !notificationDeliveryIsCurrent(record.scope)
  ) {
    return;
  }
  await registration.showNotification(label, {
    body: text.trim().slice(0, 200),
    tag: `dotli:${record.token}`,
    data: { dotliActivation: record.token },
  });
}
