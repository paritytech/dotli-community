// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Registers the sandbox's service worker, which serves an archive's files to the product's page, and keeps it fresh.

import { APP_LOG_TAG } from './appLogTag.js';
import { APP_SERVICE_WORKER_MESSAGES } from './appServiceWorkerMessages.js';
import { APP_SERVICE_WORKER_NAME } from './appServiceWorkerName.js';
import { SANDBOX_TIMEOUTS } from './timeouts.js';
import { createReporter, defineCount } from '@dotli/metrics';
import { isRecord, realTimers, withTimeout, type Timers } from '@dotli/shared';

import { SANDBOX_ERRORS } from './errors.js';

const report = createReporter({ flow: 'content' });

/** A failed registration of the sandbox service worker. Tagged `outcome` (error) and `reason` (the error's name). */
const sandboxSwRegisterMetric = defineCount<'error'>('sandbox.sw_register');

/**
 * A failed freshness check or update of the sandbox service worker. Tagged `outcome` (error) and `reason` (the
 * error's name). An update the browser refuses as expected (`TypeError`, `InvalidStateError`) is counted too.
 */
const sandboxSwUpdateMetric = defineCount<'error'>('sandbox.sw_update');

/** The page's service worker container and the build it expects that worker to run. */
export type AppServiceWorker = {
  /** `null` in a browser without service workers. */
  container: ServiceWorkerContainer | null;
  /** The build this page runs. `undefined` in a build that names none, which skips the freshness check. */
  version: string | undefined;
  /** Tells the visitor a newer version waits for a reload. May throw, and a throw counts as a failed freshness check. */
  offerReload: () => void;
};

type EnsureFreshServiceWorkerParams = {
  /** The build the page expects, and the offer of a reload. */
  app: AppServiceWorker;
  /**
   * The page's service worker container, whose controller answers the version check when the registration has no
   * active worker.
   */
  container: ServiceWorkerContainer;
  /** The registration whose worker is checked and updated. */
  registration: ServiceWorkerRegistration;
};

/**
 * Registers the worker and settles once it controls the page, or the page goes on without one. Never rejects: a
 * failed registration or wait is logged, captured and counted. `waitForFreshController` is for the full reset path:
 * unregistering does not detach the page's current controller, so it waits for a `controllerchange` rather than
 * proceed against the SW it just wiped. On that path it also settles at once when the browser kept the worker that
 * controls the page, since no `controllerchange` can come.
 */
export async function registerAppServiceWorker(
  app: AppServiceWorker,
  {
    waitForFreshController = false,
    timers = realTimers,
  }: {
    waitForFreshController?: boolean;
    /** The timers the wait for the fresh worker runs on. */
    timers?: Timers;
  } = {},
): Promise<void> {
  const { container } = app;
  if (container === null) {
    report.log.event('No service worker support, continuing without one');
    return;
  }

  try {
    const workerUrl = import.meta.env.DEV
      ? `/src/${APP_SERVICE_WORKER_NAME}.ts`
      : `${import.meta.env.BASE_URL}${APP_SERVICE_WORKER_NAME}.js`;
    const workerScope = import.meta.env.DEV ? '/' : import.meta.env.BASE_URL;
    const registration = await container.register(workerUrl, {
      type: 'module',
      scope: workerScope,
    });

    if (!waitForFreshController && container.controller) {
      void ensureFreshServiceWorker({ app, container, registration });
      return;
    }

    if (waitForFreshController && isControllerKept(registration, container)) {
      report.log.event('The reset kept the worker that controls the page');
      void ensureFreshServiceWorker({ app, container, registration });
      return;
    }

    let onControllerChange = (): void => undefined;
    const controlled = new Promise<void>(resolve => {
      onControllerChange = () => {
        resolve();
      };
      container.addEventListener('controllerchange', onControllerChange);
      void container.ready.then(readyRegistration => {
        // In the reset path only a `controllerchange` counts, so prod the new SW to claim clients sooner.
        if (!waitForFreshController && container.controller) {
          resolve();
        } else if (readyRegistration.active) {
          readyRegistration.active.postMessage({ type: APP_SERVICE_WORKER_MESSAGES.CLAIM });
        }
      });
    });
    try {
      await withTimeout({
        work: controlled,
        ms: SANDBOX_TIMEOUTS.SW_READY,
        timeoutError: () => new Error(SANDBOX_ERRORS.SW_NOT_AVAILABLE),
        timers,
      });
    } finally {
      container.removeEventListener('controllerchange', onControllerChange);
    }

    void ensureFreshServiceWorker({ app, container, registration });
  } catch (error) {
    // The page goes on, since a worker from an earlier visit may still control it and serve the archive.
    report.defect(error, {
      step: 'sw_register',
      metric: sandboxSwRegisterMetric,
      message: `${APP_LOG_TAG} Service worker registration failed; continuing without one:`,
      tags: { surface: 'sandbox_main' },
    });
  }
}

/** Whether the registration has nothing installing or waiting and its active worker is the one controlling the page. */
function isControllerKept(registration: ServiceWorkerRegistration, container: ServiceWorkerContainer): boolean {
  if (registration.installing !== null || registration.waiting !== null) {
    return false;
  }
  return container.controller !== null && registration.active === container.controller;
}

/**
 * Updates a worker whose build is not `app.version` and offers the visitor a reload. Never rejects: a failed version
 * check, update or offer is logged, captured and counted, and an update failure the browser expects is counted as
 * expected.
 */
async function ensureFreshServiceWorker(params: EnsureFreshServiceWorkerParams): Promise<void> {
  try {
    await updateIfOutdated(params);
  } catch (error) {
    report.defect(error, {
      step: 'sw_update',
      metric: sandboxSwUpdateMetric,
      message: `${APP_LOG_TAG} Service worker freshness check failed:`,
      tags: { surface: 'sandbox_main' },
    });
  }
}

/**
 * Updates a worker whose build is not `app.version` and offers the visitor a reload. A failed update is recorded, not
 * rethrown. Rejects when the version check fails with anything but silence, or when the offer throws.
 */
async function updateIfOutdated({ app, container, registration }: EnsureFreshServiceWorkerParams): Promise<void> {
  const expected = app.version;
  if (expected === undefined || expected === '') {
    return;
  }
  const active = registration.active ?? container.controller;
  if (!active) {
    return;
  }
  const actual = await queryWorkerVersion(active);
  if (actual === null || actual === expected) {
    return;
  }
  report.log.event('Service worker outdated, updating', { active: actual, expected });
  registration.update().catch((error: unknown) => {
    // A failed download rejects with TypeError, a registration a full reset removed with InvalidStateError.
    if (error instanceof Error && (error.name === 'TypeError' || error.name === 'InvalidStateError')) {
      report.expected(error, { step: 'sw_update', metric: sandboxSwUpdateMetric });
      return;
    }
    report.defect(error, {
      step: 'sw_update',
      metric: sandboxSwUpdateMetric,
      message: `${APP_LOG_TAG} Service worker update failed:`,
    });
  });
  app.offerReload();
}

/** `null` when the SW does not answer, as an older build does not. */
function queryWorkerVersion(worker: ServiceWorker): Promise<string | null> {
  const channel = new MessageChannel();
  let silent: Error | undefined;
  const answer = new Promise<string | null>(resolve => {
    channel.port1.onmessage = (event: MessageEvent<unknown>) => {
      resolve(isWorkerVersionAnswer(event.data) ? event.data.version : null);
    };
    worker.postMessage({ type: APP_SERVICE_WORKER_MESSAGES.GET_VERSION }, [channel.port2]);
  });
  return withTimeout({
    work: answer,
    ms: SANDBOX_TIMEOUTS.SW_VERSION_ANSWER,
    timeoutError: () => {
      silent = new Error('the service worker did not answer the version check');
      return silent;
    },
  })
    .catch((error: unknown) => {
      // Silence is an older build's answer, not a failure.
      if (error === silent) {
        return null;
      }
      throw error;
    })
    .finally(() => {
      channel.port1.close();
    });
}

/** Whether a worker's answer is the version it runs, checking each field before it is read. */
function isWorkerVersionAnswer(
  data: unknown,
): data is { type: typeof APP_SERVICE_WORKER_MESSAGES.VERSION; version: string } {
  return isRecord(data) && data['type'] === APP_SERVICE_WORKER_MESSAGES.VERSION && typeof data['version'] === 'string';
}
