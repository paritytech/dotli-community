// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** The part of an `install` or `activate` event the worker uses. */
type LifecycleEvent = { waitUntil(promise: Promise<unknown>): void };

/** What the retiring worker needs from its global scope. */
export type RetireShellWorkerParams = {
  /** The worker's global scope, whose `install` and `activate` events drive it. */
  scope: {
    addEventListener(type: 'install' | 'activate', listener: (event: LifecycleEvent) => void): void;
    skipWaiting(): Promise<void>;
    registration: Pick<ServiceWorkerRegistration, 'unregister'>;
    clients: { matchAll(options: { type: 'window' }): Promise<readonly Pick<WindowClient, 'url' | 'navigate'>[]> };
  };
  /** The origin's Cache Storage. */
  caches: Pick<CacheStorage, 'keys' | 'delete'>;
  /** Logs a failed step. Tests pass a fake, and the worker uses `console.error`. */
  logError?: (reason: string, error: unknown) => void;
};

// Workbox names its precache `workbox-precache-v2-<scope>`.
const PRECACHE_PREFIX = 'workbox-precache-';

/**
 * Makes the worker take over at once and, on activation, unregister itself, delete the precache and reload the old
 * shell's tabs. Never throws.
 */
export function retireShellWorker({ scope, caches, logError = logToConsole }: RetireShellWorkerParams): void {
  scope.addEventListener('install', event => {
    event.waitUntil(
      scope.skipWaiting().catch((error: unknown) => {
        logError('Failed to take over from the old shell worker:', error);
      }),
    );
  });

  scope.addEventListener('activate', event => {
    event.waitUntil(retire());
  });

  async function retire(): Promise<void> {
    await Promise.all([deletePrecache(), unregisterThenReload()]);
  }

  // Unregistering first, so a reloaded tab loads from the network with no worker in control.
  async function unregisterThenReload(): Promise<void> {
    await unregisterWorker();
    await reloadTabs();
  }

  async function unregisterWorker(): Promise<void> {
    try {
      await scope.registration.unregister();
    } catch (error) {
      logError('Failed to unregister the retired shell worker:', error);
    }
  }

  async function deletePrecache(): Promise<void> {
    try {
      const cacheNames = await caches.keys();
      const precaches = cacheNames.filter(name => name.startsWith(PRECACHE_PREFIX));
      await Promise.all(precaches.map(name => caches.delete(name)));
    } catch (error) {
      logError("Failed to delete the old shell's precache:", error);
    }
  }

  async function reloadTabs(): Promise<void> {
    try {
      const tabs = await scope.clients.matchAll({ type: 'window' });
      await Promise.all(tabs.map(tab => reloadTab(tab)));
    } catch (error) {
      logError("Failed to list the old shell's tabs:", error);
    }
  }

  async function reloadTab(tab: Pick<WindowClient, 'url' | 'navigate'>): Promise<void> {
    try {
      await tab.navigate(tab.url);
    } catch (error) {
      logError(`Failed to reload the old shell's tab at ${tab.url}:`, error);
    }
  }
}

function logToConsole(reason: string, error: unknown): void {
  // eslint-disable-next-line no-console -- the worker has no logger, and its only pages are the old shell it retires
  console.error(reason, error);
}
