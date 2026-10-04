// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// PWA registration for the host shell.
//
// Uses workbox-window so updates are prompted, not auto-applied:
//   1. Register /host-sw.js
//   2. On `waiting`, surface a notification asking the user to reload
//   3. On confirm, message the waiting SW with SKIP_WAITING and reload
//      once the new SW takes control
//   4. Poll for updates every 15 min and whenever a hidden tab returns
//
// Scope is the host origin only. The protocol iframe (host.dot.li) and
// the app iframe (*.app.dot.li) are cross-origin and untouched.

import { Workbox } from 'workbox-window';
import { showNotification } from '@dotli/ui';
import { log } from '@dotli/shared';
import { SANDBOX_SCHEMA_VERSION } from '@dotli/config';

const UPDATE_INTERVAL_MS = 15 * 60 * 1000;

if ('serviceWorker' in navigator) {
  const wb = new Workbox('/host-sw.js', { updateViaCache: 'none' });
  navigator.serviceWorker.addEventListener('message', (event: MessageEvent<unknown>) => {
    const data = event.data;
    const reply = event.ports.at(0);
    if (
      typeof data !== 'object' ||
      data === null ||
      !('type' in data) ||
      data.type !== 'dotli:host-contract-version' ||
      reply === undefined
    ) {
      return;
    }
    reply.postMessage({ version: SANDBOX_SCHEMA_VERSION });
    reply.close();
  });
  let hostUpdateRequired = false;
  let applyingUpdate = false;

  const applyWaitingUpdate = (): void => {
    if (applyingUpdate) {
      return;
    }
    applyingUpdate = true;
    wb.addEventListener('controlling', () => {
      window.location.reload();
    });
    wb.messageSkipWaiting();
  };

  wb.addEventListener('waiting', () => {
    if (hostUpdateRequired) {
      applyWaitingUpdate();
      return;
    }
    showNotification({
      label: 'Update available',
      text: 'A new version of dot.li is ready. Reload to apply.',
      dismissMs: 0,
      action: {
        label: 'Reload',
        onClick: applyWaitingUpdate,
      },
    });
  });

  const registrationPromise = wb
    .register()
    .then(registration => {
      if (!registration) {
        return undefined;
      }
      // The UI also looks up the registration if its listener mounts later.
      // Keep the registration host-owned: it is never sent into a product.
      window.dispatchEvent(new CustomEvent('dotli:receiving-registration', { detail: registration }));
      setInterval(() => {
        if (navigator.onLine) {
          void registration.update();
        }
      }, UPDATE_INTERVAL_MS);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && navigator.onLine) {
          void registration.update();
        }
      });
      return registration;
    })
    .catch((err: unknown) => {
      log.warn(`[dot.li] SW registration failed: ${String(err)}`);
      return undefined;
    });

  // The sandbox emits this only when its schema is newer than the contract
  // supplied by this host build. Consent is no longer relevant: the current
  // host cannot run the app safely, so activate a waiting compatible build.
  window.addEventListener('dotli:host-update-required', () => {
    hostUpdateRequired = true;
    void registrationPromise.then(registration => {
      if (!registration) {
        return;
      }
      if (registration.waiting) {
        applyWaitingUpdate();
        return;
      }
      void registration.update();
    });
  });
}
