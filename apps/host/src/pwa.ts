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
//
// Scope is the host origin only. The protocol iframe (host.dot.li) and
// the app iframe (*.app.dot.li) are cross-origin and untouched.

import { Workbox } from 'workbox-window';
import { captureException, recordExpected } from '@dotli/metrics';
import { showNotification } from '@dotli/ui';
import { markContinuation } from '@dotli/shared';

const UPDATE_INTERVAL_MS = 15 * 60 * 1000;

if ('serviceWorker' in navigator) {
  const wb = new Workbox('/host-sw.js');

  const applyUpdate = (): void => {
    const reload = (): void => {
      markContinuation('app_update');
      window.location.reload();
    };
    void navigator.serviceWorker.getRegistration().then(registration => {
      // Another tab's Reload may have applied the update already. Its
      // activation took this page over too, so nothing waits now and no
      // `controlling` would ever come.
      if ((registration?.waiting ?? null) === null) {
        reload();
        return;
      }
      // Reload once the new SW is in control to avoid serving a mix of
      // old and new chunks during the swap.
      wb.addEventListener('controlling', reload);
      wb.messageSkipWaiting();
    });
  };

  wb.addEventListener('waiting', event => {
    if (event.wasWaitingBeforeRegister === true) {
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
  void wb
    .register({ immediate: true })
    .then(registration => {
      if (!registration) {
        return;
      }
      // An update check fails whenever the script cannot be fetched or the
      // registration went away under it (offline, a deploy mid-fetch, storage
      // cleared). The next check retries, so a failed one is only a crumb.
      const checkForUpdate = (): void => {
        registration.update().catch((err: unknown) => {
          recordExpected(err, { flow: 'pwa', step: 'sw_update' });
        });
      };
      setInterval(() => {
        if (navigator.onLine) {
          checkForUpdate();
        }
      }, UPDATE_INTERVAL_MS);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && navigator.onLine) {
          checkForUpdate();
        }
      });
    })
    .catch((err: unknown) => {
      captureException(err, { flow: 'pwa', step: 'sw_register' });
    });
}
