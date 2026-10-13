// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Updates are prompted, not auto-applied, unless one was already waiting at page load, when nothing is in use yet.

import { captureException, recordExpected } from '@dotli/metrics';
import { showNotification, type ShowNotification } from '@dotli/ui-widgets';
import { markContinuation } from './continuation.js';
import { parseDotLabel } from './dot-label.js';
import { loadWorkboxWindow } from './lazy.js';

const UPDATE_INTERVAL_MS = 15 * 60 * 1000;

/** The part of Workbox the shell uses. */
export interface PwaWorkbox {
  addEventListener(
    type: 'waiting',
    listener: (event: { wasWaitingBeforeRegister?: boolean | undefined }) => void,
  ): void;
  addEventListener(type: 'controlling', listener: () => void): void;
  messageSkipWaiting(): void;
  register(options: { immediate: boolean }): Promise<Pick<ServiceWorkerRegistration, 'update'> | undefined>;
}

export interface PwaDeps {
  /** The dev server builds no worker, and a precache would serve stale modules over its live ones. */
  production: boolean;
  /** Null on the bare host, whose root the worker's fallback would answer with the shell rather than the landing page. */
  label: string | null;
  /** Undefined where the browser has no service workers. */
  serviceWorker: Pick<ServiceWorkerContainer, 'getRegistration'> | undefined;
  /** Async, so Workbox stays out of the boot chunk. */
  createWorkbox: (scriptUrl: string) => Promise<PwaWorkbox>;
  showNotification: ShowNotification;
  reload: () => void;
}

function pageDeps(): PwaDeps {
  return {
    production: import.meta.env.PROD,
    label: parseDotLabel(),
    serviceWorker: 'serviceWorker' in navigator ? navigator.serviceWorker : undefined,
    createWorkbox: async scriptUrl => new (await loadWorkboxWindow()).Workbox(scriptUrl),
    showNotification,
    reload: () => {
      markContinuation('app_update');
      window.location.reload();
    },
  };
}

/** Registers the shell's service worker on a product host and offers its updates. Call once per page. */
export function startPwa(deps: PwaDeps = pageDeps()): void {
  const { serviceWorker } = deps;
  if (!deps.production || serviceWorker === undefined || deps.label === null) {
    return;
  }
  void deps.createWorkbox('/host-sw.js').then(
    wb => {
      registerShellWorker(wb, serviceWorker, deps);
    },
    (err: unknown) => {
      captureException(err, { flow: 'pwa', step: 'sw_load' });
    },
  );
}

function registerShellWorker(
  wb: PwaWorkbox,
  serviceWorker: Pick<ServiceWorkerContainer, 'getRegistration'>,
  deps: PwaDeps,
): void {
  const applyUpdate = (): void => {
    void serviceWorker.getRegistration().then(registration => {
      // Another tab's Reload may have applied the update already, and then no `controlling` ever comes.
      if ((registration?.waiting ?? null) === null) {
        deps.reload();
        return;
      }
      // Reload once the new SW is in control, so old and new chunks never mix.
      wb.addEventListener('controlling', deps.reload);
      wb.messageSkipWaiting();
    });
  };

  wb.addEventListener('waiting', event => {
    if (event.wasWaitingBeforeRegister === true) {
      applyUpdate();
      return;
    }
    deps.showNotification({
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
