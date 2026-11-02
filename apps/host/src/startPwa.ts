// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Updates are prompted, not auto-applied, unless one was already waiting at page load, when nothing is in use yet.

import { reportDefect, reportExpected, spans as S } from '@dotli/metrics';
import { listenForDocumentVisible, log, type VisibilitySource } from '@dotli/shared';
import { showNotification, type ShowNotification } from '@dotli/ui';
import { markAndReload } from './createContinuation.js';
import { parseDotLabel } from './parseDotLabel.js';
import { loadWorkboxWindow } from './lazy.js';
import { pagePoll, type Poll } from './pagePoll.js';

/** The part of Workbox the shell uses. */
export type PwaWorkbox = {
  /** Calls `listener` each time a new worker takes control of the page. Never throws. */
  addEventListener(type: 'controlling', listener: () => void): void;
  /** Removes `listener`, and does nothing for one not added. Never throws. */
  removeEventListener(type: 'controlling', listener: () => void): void;
  /** Tells the waiting worker to take over. Never throws. */
  messageSkipWaiting(): void;
  /** Registers the worker. Resolves its registration, or undefined where none was made, and rejects when it fails. */
  register(options: { immediate: boolean }): Promise<PwaRegistration | undefined>;
};

/** The part of the worker's registration the shell uses. */
export type PwaRegistration = {
  /** The worker that serves the page, or null before the first install. */
  readonly active: object | null;
  /** The release the browser is installing, or null for none. */
  readonly installing: PwaWorker | null;
  /** An installed release waiting to take over, or null for none. */
  readonly waiting: object | null;
  /** Calls `listener` each time the browser finds a new release, until `signal` aborts. Never throws. */
  addEventListener(type: 'updatefound', listener: () => void, options: { signal: AbortSignal }): void;
  /** Asks the server for a new release. Rejects when the check fails. */
  update(): Promise<unknown>;
};

/** The part of a service worker the shell uses. */
export type PwaWorker = {
  /** Where the worker is in its install. */
  readonly state: ServiceWorkerState;
  /** Calls `listener` on the worker's next state change, unless `signal` aborts first. Never throws. */
  addEventListener(type: 'statechange', listener: () => void, options: { once: true; signal: AbortSignal }): void;
};

/** What the update checks read from the page. */
export type PwaPage = {
  /** Returns whether the browser is online. Never throws. */
  isOnline: () => boolean;
  /** Tells when the visitor returns to the page. */
  visibility: VisibilitySource;
  /** Runs the scheduled update check. */
  poll: Poll;
};

export type PwaParams = {
  /** The dev server builds no worker, and a precache would serve stale modules over its live ones. */
  production: boolean;
  /** Null on the bare host, whose root the worker's fallback would answer with the shell rather than the landing page. */
  label: string | null;
  /** False where the browser has no service workers. */
  serviceWorkers: boolean;
  /** Async, so Workbox stays out of the boot chunk. */
  createWorkbox: (scriptUrl: string) => Promise<PwaWorkbox>;
  /** Offers an update. */
  showNotification: ShowNotification;
  /** Reloads the page onto the update. */
  reload: () => void;
  page: PwaPage;
};

/** Where an update is offered and how the page reloads onto it. */
type Updates = Pick<PwaParams, 'showNotification' | 'reload' | 'page'>;

type RegisterShellWorkerParams = {
  /** The worker's Workbox, which registers it and applies an update. */
  workbox: PwaWorkbox;
  updates: Updates;
  /** Aborts once the page stops offering updates, which removes every listener the offer added. */
  signal: AbortSignal;
};

type OfferUpdatesParams = RegisterShellWorkerParams & {
  /** The shell worker's registration. */
  registration: PwaRegistration;
};

const UPDATE_INTERVAL_MS = 15 * 60 * 1000;

const pwaLog = log.createChild({ flow: 'pwa' });

/**
 * Registers the shell's service worker on a product host and offers its updates until the returned dispose. Call once
 * per page. Never throws: a failed load or registration is reported.
 */
export function startPwa(
  { production, label, serviceWorkers, createWorkbox, ...updates }: PwaParams = getPageParams(),
): () => void {
  const lifetime = new AbortController();
  if (!production || !serviceWorkers || label === null) {
    return dispose;
  }
  void createWorkbox('/host-sw.js').then(
    workbox => {
      registerShellWorker({ workbox, updates, signal: lifetime.signal });
    },
    (error: unknown) => {
      reportDefect(error, {
        flow: 'pwa',
        step: 'sw_load',
        metric: S.PWA_SW_LOAD,
        message: '[dot.li pwa] the service worker could not load:',
        logger: pwaLog,
      });
    },
  );
  return dispose;

  function dispose(): void {
    lifetime.abort();
  }
}

function getPageParams(): PwaParams {
  return {
    production: import.meta.env.PROD,
    label: parseDotLabel(),
    serviceWorkers: 'serviceWorker' in navigator,
    createWorkbox: async scriptUrl => new (await loadWorkboxWindow()).Workbox(scriptUrl),
    showNotification,
    reload() {
      markAndReload('app_update');
    },
    page: {
      isOnline: () => navigator.onLine,
      visibility: document,
      poll: pagePoll,
    },
  };
}

function registerShellWorker({ workbox, updates, signal }: RegisterShellWorkerParams): void {
  // Not deferred to `load`, which waits for the app iframe, so a waiting update applies before the page is in use.
  void workbox
    .register({ immediate: true })
    .then(registration => {
      if (!registration || signal.aborted) {
        return;
      }
      offerUpdates({ workbox, registration, updates, signal });
    })
    .catch((error: unknown) => {
      reportDefect(error, {
        flow: 'pwa',
        step: 'sw_register',
        metric: S.PWA_SW_REGISTER,
        message: '[dot.li pwa] the service worker could not register:',
        logger: pwaLog,
      });
    });
}

/**
 * Applies an update already waiting, else offers each one the browser finds and checks for one on a schedule and on
 * each return to the page, until `signal` aborts. Throws only as `registration` or `updates` do.
 */
function offerUpdates({ workbox, registration, updates, signal }: OfferUpdatesParams): void {
  function applyUpdate(): void {
    // Another tab's Reload may have applied the update already, and then no `controlling` ever comes.
    if (registration.waiting === null) {
      updates.reload();
      return;
    }
    // Reload once the new SW is in control, so old and new chunks never mix.
    workbox.addEventListener('controlling', updates.reload);
    signal.addEventListener('abort', stopReloadOnControl, { once: true });
    workbox.messageSkipWaiting();
  }
  function stopReloadOnControl(): void {
    workbox.removeEventListener('controlling', updates.reload);
  }
  if (registration.waiting !== null) {
    applyUpdate();
    return;
  }

  // Offered as soon as the browser finds it, not once it has downloaded, which takes as long as the release is large.
  function offerInstalling(): void {
    const worker = registration.installing;
    // Without an active worker this is the first install, which serves this very release.
    if (worker === null || registration.active === null) {
      return;
    }
    const installed = waitForInstallEnd(worker, signal);
    updates.showNotification({
      label: 'Update available',
      text: 'A new version of dot.li is available. Reload to apply.',
      dismissMs: 0,
      action: {
        label: 'Reload',
        onClick() {
          void installed.then(applyUpdate);
        },
      },
    });
  }
  registration.addEventListener('updatefound', offerInstalling, { signal });
  // The navigation's own check may have found one before the shell listened.
  offerInstalling();

  // A check fails when offline, mid-deploy or after storage is cleared. The next one retries, so it is expected.
  function checkForUpdate(): void {
    if (!updates.page.isOnline()) {
      return;
    }
    registration.update().catch((error: unknown) => {
      reportExpected(error, { flow: 'pwa', step: 'sw_update', metric: S.PWA_SW_UPDATE });
    });
  }
  // Registering the unchanged worker checks nothing, and the browser's own check after a navigation has no set time.
  checkForUpdate();
  const stopPoll = updates.page.poll.start(checkForUpdate, UPDATE_INTERVAL_MS);
  const stopListening = listenForDocumentVisible(updates.page.visibility, checkForUpdate);
  function stopChecks(): void {
    stopPoll();
    stopListening();
  }
  signal.addEventListener('abort', stopChecks, { once: true });
}

/**
 * Resolves once `worker` is past installing, whether it installed or failed. Never rejects, and never settles once
 * `signal` aborts first.
 */
function waitForInstallEnd(worker: PwaWorker, signal: AbortSignal): Promise<void> {
  if (worker.state !== 'installing') {
    return Promise.resolve();
  }
  return new Promise(resolve => {
    worker.addEventListener(
      'statechange',
      () => {
        resolve();
      },
      { once: true, signal },
    );
  });
}
