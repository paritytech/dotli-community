// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Updates are prompted, not auto-applied, unless one was already waiting at page load, when nothing is in use yet.

import { captureException, recordExpected } from '@dotli/metrics';
import { showNotification, type ShowNotification } from '@dotli/ui';
import { markContinuation } from './continuation.js';
import { parseDotLabel } from './dot-label.js';
import { loadWorkboxWindow } from './lazy.js';

const UPDATE_INTERVAL_MS = 15 * 60 * 1000;

/** The part of Workbox the shell uses. */
export interface PwaWorkbox {
  addEventListener(type: 'controlling', listener: () => void): void;
  messageSkipWaiting(): void;
  register(options: { immediate: boolean }): Promise<PwaRegistration | undefined>;
}

/** The part of the worker's registration the shell uses. */
export interface PwaRegistration {
  readonly active: object | null;
  readonly installing: PwaWorker | null;
  readonly waiting: object | null;
  addEventListener(type: 'updatefound', listener: () => void): void;
  update(): Promise<unknown>;
}

/** The part of a service worker the shell uses. */
export interface PwaWorker {
  readonly state: ServiceWorkerState;
  addEventListener(type: 'statechange', listener: () => void, options: { once: true }): void;
}

/** What the update checks read from the page. */
export interface PwaPage {
  isHidden: () => boolean;
  isOnline: () => boolean;
  /** Fires `visibilitychange`. */
  visibility: EventTarget;
  every: (ms: number, run: () => void) => void;
}

export interface PwaDeps {
  /** The dev server builds no worker, and a precache would serve stale modules over its live ones. */
  production: boolean;
  /** Null on the bare host, whose root the worker's fallback would answer with the shell rather than the landing page. */
  label: string | null;
  /** False where the browser has no service workers. */
  serviceWorkers: boolean;
  /** Async, so Workbox stays out of the boot chunk. */
  createWorkbox: (scriptUrl: string) => Promise<PwaWorkbox>;
  showNotification: ShowNotification;
  reload: () => void;
  page: PwaPage;
}

function pageDeps(): PwaDeps {
  return {
    production: import.meta.env.PROD,
    label: parseDotLabel(),
    serviceWorkers: 'serviceWorker' in navigator,
    createWorkbox: async scriptUrl => new (await loadWorkboxWindow()).Workbox(scriptUrl),
    showNotification,
    reload: () => {
      markContinuation('app_update');
      window.location.reload();
    },
    page: {
      isHidden: () => document.hidden,
      isOnline: () => navigator.onLine,
      visibility: document,
      every: (ms, run) => {
        setInterval(run, ms);
      },
    },
  };
}

/** Registers the shell's service worker on a product host and offers its updates. Call once per page. */
export function startPwa(deps: PwaDeps = pageDeps()): void {
  if (!deps.production || !deps.serviceWorkers || deps.label === null) {
    return;
  }
  void deps.createWorkbox('/host-sw.js').then(
    wb => {
      registerShellWorker(wb, deps);
    },
    (err: unknown) => {
      captureException(err, { flow: 'pwa', step: 'sw_load' });
    },
  );
}

function registerShellWorker(wb: PwaWorkbox, deps: PwaDeps): void {
  // Not deferred to `load`, which waits for the app iframe, so a waiting update applies before the page is in use.
  void wb
    .register({ immediate: true })
    .then(registration => {
      if (!registration) {
        return;
      }
      const applyUpdate = (): void => {
        // Another tab's Reload may have applied the update already, and then no `controlling` ever comes.
        if (registration.waiting === null) {
          deps.reload();
          return;
        }
        // Reload once the new SW is in control, so old and new chunks never mix.
        wb.addEventListener('controlling', deps.reload);
        wb.messageSkipWaiting();
      };
      if (registration.waiting !== null) {
        applyUpdate();
        return;
      }

      // Offered as soon as the browser finds it, not once it has downloaded, which takes as long as the release is large.
      const offerInstalling = (): void => {
        const worker = registration.installing;
        // Without an active worker this is the first install, which serves this very release.
        if (worker === null || registration.active === null) {
          return;
        }
        const installed = installSettled(worker);
        deps.showNotification({
          label: 'Update available',
          text: 'A new version of dot.li is available. Reload to apply.',
          dismissMs: 0,
          action: {
            label: 'Reload',
            onClick: () => {
              void installed.then(applyUpdate);
            },
          },
        });
      };
      registration.addEventListener('updatefound', offerInstalling);
      // The navigation's own check may have found one before the shell listened.
      offerInstalling();

      // A check fails when offline, mid-deploy or after storage is cleared. The next one retries, so it is a crumb.
      const checkForUpdate = (): void => {
        if (!deps.page.isOnline()) {
          return;
        }
        registration.update().catch((err: unknown) => {
          recordExpected(err, { flow: 'pwa', step: 'sw_update' });
        });
      };
      // Registering the unchanged worker checks nothing, and the browser's own check after a navigation has no set time.
      checkForUpdate();
      deps.page.every(UPDATE_INTERVAL_MS, checkForUpdate);
      deps.page.visibility.addEventListener('visibilitychange', () => {
        if (!deps.page.isHidden()) {
          checkForUpdate();
        }
      });
    })
    .catch((err: unknown) => {
      captureException(err, { flow: 'pwa', step: 'sw_register' });
    });
}

/** Settles once `worker` is past installing, whether it installed or failed. */
function installSettled(worker: PwaWorker): Promise<void> {
  if (worker.state !== 'installing') {
    return Promise.resolve();
  }
  return new Promise(resolve => {
    worker.addEventListener(
      'statechange',
      () => {
        resolve();
      },
      { once: true },
    );
  });
}
