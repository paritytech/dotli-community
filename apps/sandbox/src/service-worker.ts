// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The sandbox's service worker, which serves an archive's files to the product's page.

import { TIMEOUTS } from '@dotli/config';
import { packArchive, type ArchiveFiles } from '@dotli/content';
import { captureException, recordExpected } from '@dotli/metrics';
import { log } from '@dotli/shared';

import { handOverArchive } from './archive-handoff.js';
import { showNotification } from '@dotli/ui-widgets';
import { SANDBOX_ERRORS } from './errors.js';

const contentLog = log.child({ flow: 'content' });

/** The page's service worker container and the build it expects that worker to run. */
export interface AppServiceWorker {
  /** `null` in a browser without service workers. */
  container: ServiceWorkerContainer | null;
  /** The build this page runs. `undefined` in a build that names none, which skips the freshness check. */
  version: string | undefined;
  /** Tells the visitor a newer version waits for a reload. */
  offerReload: () => void;
}

/** `null` when the SW does not answer, as an older build does not. */
function querySwVersion(sw: ServiceWorker): Promise<string | null> {
  return new Promise(resolve => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => {
      channel.port1.close();
      resolve(null);
    }, 1_000);
    channel.port1.onmessage = (event: MessageEvent) => {
      clearTimeout(timer);
      channel.port1.close();
      const data = event.data as { type?: string; version?: string } | null;
      resolve(data?.type === 'SW_VERSION' && typeof data.version === 'string' ? data.version : null);
    };
    sw.postMessage({ type: 'GET_SW_VERSION' }, [channel.port2]);
  });
}

/** A mismatched SW updates at once and self-promotes, so any reload gets fresh assets. The page reloads on request. */
async function ensureFreshServiceWorker(
  app: AppServiceWorker,
  container: ServiceWorkerContainer,
  registration: ServiceWorkerRegistration,
): Promise<void> {
  const expected = app.version;
  if (expected === undefined || expected === '') {
    return;
  }
  const active = registration.active ?? container.controller;
  if (!active) {
    return;
  }
  const actual = await querySwVersion(active);
  if (actual === null || actual === expected) {
    return;
  }
  log.event('Service worker outdated, updating', { flow: 'content', active: actual, expected });
  registration.update().catch((err: unknown) => {
    // A failed download rejects with TypeError, a registration a full reset removed with InvalidStateError.
    if (err instanceof Error && (err.name === 'TypeError' || err.name === 'InvalidStateError')) {
      recordExpected(err, { flow: 'content', step: 'sw_update' });
      return;
    }
    captureException(err, { flow: 'content', step: 'sw_update' });
  });
  app.offerReload();
}

/** The page's own reload offer. */
export function offerReloadNotice(): void {
  showNotification({
    label: 'New version available',
    text: `App was updated. Reload to use the latest version.`,
    dismissMs: 0,
    action: {
      label: 'Reload',
      onClick: () => {
        window.location.reload();
      },
    },
  });
}

/**
 * `waitForFreshController` is for the full reset path: unregistering does not detach the page's current controller,
 * so it waits for a `controllerchange` rather than proceed against the SW it just wiped.
 */
export async function registerAppServiceWorker(
  app: AppServiceWorker,
  { waitForFreshController = false }: { waitForFreshController?: boolean } = {},
): Promise<void> {
  const { container } = app;
  if (container === null) {
    contentLog.warn('[dot.li app] No Service Worker support; continuing without one');
    return;
  }

  try {
    const swUrl = import.meta.env.DEV ? '/src/app-sw.ts' : `${import.meta.env.BASE_URL}app-sw.js`;
    const swScope = import.meta.env.DEV ? '/' : import.meta.env.BASE_URL;
    const registration = await container.register(swUrl, {
      type: 'module',
      scope: swScope,
    });

    if (!waitForFreshController && container.controller) {
      void ensureFreshServiceWorker(app, container, registration);
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(SANDBOX_ERRORS.SW_NOT_AVAILABLE));
      }, TIMEOUTS.SW_READY);
      container.addEventListener('controllerchange', () => {
        clearTimeout(timeout);
        resolve();
      });
      void container.ready.then(readyRegistration => {
        // In the reset path only a `controllerchange` counts, so prod the new SW to claim clients sooner.
        if (!waitForFreshController && container.controller) {
          clearTimeout(timeout);
          resolve();
        } else if (readyRegistration.active) {
          readyRegistration.active.postMessage({ type: 'SW_CLAIM_EVENT' });
        }
      });
    });

    void ensureFreshServiceWorker(app, container, registration);
  } catch (err) {
    contentLog.warn('[dot.li app] Service worker registration failed; continuing without one:', err);
    captureException(err, { flow: 'content', step: 'sw_register', tags: { surface: 'sandbox_main' } });
  }
}

/**
 * Call once, and for the whole page, since these arrive after the load, often after the dApp replaced this document.
 */
export function listenForArchiveFailures(container: ServiceWorkerContainer | null): void {
  if (container === null) {
    return;
  }
  container.addEventListener('message', (evt: MessageEvent) => {
    const msg = evt.data as { type?: unknown; stage?: unknown; name?: unknown; message?: unknown } | null;
    if (msg?.type !== 'ARCHIVE_FAILURE') {
      return;
    }
    const err = new Error(typeof msg.message === 'string' ? msg.message : 'unknown archive failure');
    if (typeof msg.name === 'string' && msg.name !== '') {
      err.name = msg.name;
    }
    captureException(err, {
      flow: 'content',
      step: msg.stage === 'restore' ? 'sw_restore' : 'sw_persist',
      tags: { surface: 'app_sw' },
    });
  });
}

/** Before document.write(), or sub-resource requests fall through to nginx's HTML fallback. */
export async function storeArchiveInSW(container: ServiceWorkerContainer | null, files: ArchiveFiles): Promise<void> {
  const sw = container?.controller ?? null;
  if (!sw) {
    contentLog.warn(
      `[dot.li app] No Service Worker controls the page; ${String(Object.keys(files).length)} archive files will not be served`,
    );
    return;
  }

  // The page-wide channel too, for one release, since a worker from the previous deploy ignores the port.
  await handOverArchive(sw, packArchive(files), container);
}
