// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/// <reference lib="webworker" />

import { activateNotification } from '@dotli/storage/notification-activations';

const scope = self as unknown as ServiceWorkerGlobalScope;

function hostUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    if (
      (url.protocol === 'https:' || url.protocol === 'http:') &&
      url.origin === scope.location.origin &&
      !url.username &&
      !url.password
    ) {
      return url;
    }
    // eslint-disable-next-line no-restricted-syntax -- malformed URLs are rejected, not recovered.
  } catch {
    // A malformed durable entry must never become navigation authority.
  }
  return undefined;
}

async function activate(token: string): Promise<void> {
  // The transaction commits before a page is focused or opened. Reloads and
  // account changes can then recover the activation through authenticated polling.
  const record = await activateNotification(token);
  if (!record) {
    return;
  }
  const entry = hostUrl(record.entryUrl);
  if (!entry) {
    return;
  }

  const windows = await scope.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const hosts = windows.filter(
    client =>
      (client.frameType === 'top-level' || client.frameType === 'auxiliary') && hostUrl(client.url) !== undefined,
  );
  const target = hosts.find(client => client.focused) ?? hosts[0];
  if (target) {
    const focused = await target.focus();
    // This is only a wake hint. The page resolves durable state and authenticates
    // its product/account/network/artifact; no route or identity crosses this channel.
    focused.postMessage({ type: 'dotli:notification-activation' });
  } else {
    await scope.clients.openWindow(entry.href);
  }
}

// Imported into the existing host service worker; no independent registration,
// receiving enrollment, relay, or product-controlled URL is involved.
scope.addEventListener('notificationclick', event => {
  const data: unknown = event.notification.data;
  if (
    typeof data !== 'object' ||
    data === null ||
    Array.isArray(data) ||
    !('dotliActivation' in data) ||
    Object.keys(data).length !== 1 ||
    typeof data.dotliActivation !== 'string' ||
    data.dotliActivation.length === 0
  ) {
    return;
  }

  event.notification.close();
  event.waitUntil(
    activate(data.dotliActivation).catch((error: unknown) => {
      console.warn('[dot.li] Notification activation failed', error);
    }),
  );
});
