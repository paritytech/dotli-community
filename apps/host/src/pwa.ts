// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Updates are prompted, not auto-applied, unless one was already waiting at page load, when nothing is in use yet.

import { Workbox } from 'workbox-window';
import { captureException, recordExpected } from '@dotli/metrics';
import { showNotification } from '@dotli/ui';
import { markContinuation } from '@dotli/shared';
import { parseDotLabel } from './dot-label.js';

const UPDATE_INTERVAL_MS = 15 * 60 * 1000;

// Only on a product host. On the bare host its fallback would answer the root with the shell rather than the landing
// page. The dev server builds no worker, and a precache would serve stale modules over its live ones.
if (import.meta.env.PROD && 'serviceWorker' in navigator && parseDotLabel() !== null) {
  const wb = new Workbox('/host-sw.js');

  const applyUpdate = (): void => {
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

  // Not deferred to `load`, which waits for the app iframe, so a waiting update applies before the page is in use.
  void wb
    .register({ immediate: true })
    .then(registration => {
      if (!registration) {
        return;
      }
      // A check fails when offline, mid-deploy or after storage is cleared. The next one retries, so it is a crumb.
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
