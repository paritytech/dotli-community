// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// PWA registration for the host shell.
//
// Uses workbox-window so updates are prompted, not auto-applied:
//   1. Register /host-sw.js
//   2. On `waiting`, surface a notification asking the user to reload
//   3. On confirm, message the waiting SW with SKIP_WAITING and reload
//      once the new SW takes control
//   4. If a SW was already waiting when the page loaded (a plain reload),
//      apply it at once without asking: nothing on the page is in use yet
//   5. Poll for updates every 15 min and whenever a hidden tab returns
//   6. If the sandbox reports that this host build is too old for the app,
//      apply a waiting (or freshly fetched) update without asking
//
// Scope is the host origin only. The protocol iframe (host.dot.li) and
// the app iframe (*.app.dot.li) are cross-origin and untouched.

import { Workbox } from 'workbox-window';
import { captureException, recordExpected } from '@dotli/metrics';
import { showNotification } from '@dotli/ui';
import { markContinuation } from '@dotli/shared';
import { SANDBOX_SCHEMA_VERSION } from '@dotli/config';
import { parseDotLabel } from './dot-label.js';

const UPDATE_INTERVAL_MS = 15 * 60 * 1000;

// An update check fails whenever the script cannot be fetched or the
// registration went away under it (offline, a deploy mid-fetch, storage
// cleared). The next check retries, so a failed one is only a crumb.
function checkForUpdate(registration: ServiceWorkerRegistration): void {
  registration.update().catch((err: unknown) => {
    recordExpected(err, { flow: 'pwa', step: 'sw_update' });
  });
}

// Product hosts only: a worker on the bare host would replace the static landing page with the shell.
if (import.meta.env.PROD && 'serviceWorker' in navigator && parseDotLabel() !== null) {
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

  const applyUpdate = (): void => {
    if (applyingUpdate) {
      return;
    }
    applyingUpdate = true;
    const reload = (): void => {
      markContinuation('app_update');
      window.location.reload();
    };
    void navigator.serviceWorker.getRegistration().then(registration => {
      // Another tab's Reload may have applied the update already, and then no `controlling` ever comes.
      if ((registration?.waiting ?? null) === null) {
        reload();
        return;
      }
      // Reload once the new SW is in control, so old and new chunks never mix.
      wb.addEventListener('controlling', reload);
      wb.messageSkipWaiting();
    });
  };

  wb.addEventListener('waiting', event => {
    if (event.wasWaitingBeforeRegister === true || hostUpdateRequired) {
      applyUpdate();
      return;
    }
    showNotification({
      label: 'Update available',
      text: 'A new version of dot.li is ready. Reload to apply.',
      dismissMs: 0,
      action: { label: 'Reload', onClick: applyUpdate },
    });
  });

  // Not deferred to `load`, which waits for the app iframe: a waiting
  // update is applied before anyone starts using the page.
  const registrationPromise = wb
    .register({ immediate: true })
    .then(registration => {
      if (!registration) {
        return undefined;
      }
      setInterval(() => {
        if (navigator.onLine) {
          checkForUpdate(registration);
        }
      }, UPDATE_INTERVAL_MS);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && navigator.onLine) {
          checkForUpdate(registration);
        }
      });
      return registration;
    })
    .catch((err: unknown) => {
      captureException(err, { flow: 'pwa', step: 'sw_register' });
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
        applyUpdate();
        return;
      }
      checkForUpdate(registration);
    });
  });
}
