// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { bindCaptureSink } from '@dotli/metrics';
import { bindRecordingSentry } from '@dotli/metrics/testing';
import { createDeferred } from '@dotli/shared';
import { createManualTimers, recordLog } from '@dotli/shared/testing';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { registerAppServiceWorker, type AppServiceWorker } from './registerAppServiceWorker.js';
import { createCountingEventTarget } from './testing/createCountingEventTarget.js';
import { SANDBOX_TIMEOUTS } from './timeouts.js';

type CreateControlledContainerParams = {
  /** The worker that controls the page and that the registration holds. */
  active: ServiceWorker;
  /** The registration's update of that worker. */
  update: () => Promise<void>;
};

type CreateFreshContainerParams = {
  /** The worker that controls the page. */
  controller?: ServiceWorker | null;
  /** The registration's active worker. */
  active?: ServiceWorker | null;
  /** The registration's installing worker. */
  installing?: ServiceWorker | null;
};

/** A worker that answers the version check with `version`. */
function createWorkerAt(version: string): ServiceWorker {
  // The version check reads only `postMessage`.
  return {
    postMessage(_message: unknown, transfer: Transferable[]) {
      const [port] = transfer;
      if (port instanceof MessagePort) {
        port.postMessage({ type: 'SW_VERSION', version });
      }
    },
  } as unknown as ServiceWorker;
}

/** A worker whose every post throws `failure`, as one the browser has made redundant does. */
function createUnreachableWorker(failure: Error): ServiceWorker {
  // The version check reads only `postMessage`.
  return {
    postMessage: () => {
      throw failure;
    },
  } as unknown as ServiceWorker;
}

/** A page `active` already controls, whose registration holds `active` and updates it with `update`. */
function createControlledContainer({ active, update }: CreateControlledContainerParams): ServiceWorkerContainer {
  // The freshness check reads only these two members of the registration.
  const registration = { active, update } as unknown as ServiceWorkerRegistration;
  // The registration of a controlled page reads only these two members of the container.
  return { controller: active, register: () => Promise.resolve(registration) } as unknown as ServiceWorkerContainer;
}

/**
 * A page controlled by `controller` (none by default), whose registration holds `active` and an `installing` worker,
 * counting the `controllerchange` listeners still attached.
 */
function createFreshContainer({
  controller = null,
  active = null,
  installing = null,
}: CreateFreshContainerParams = {}) {
  const events = createCountingEventTarget({ type: 'controllerchange' });
  // The wait for a fresh worker reads only these members of the container and of its registration.
  const container = {
    ...events,
    controller,
    ready: new Promise<ServiceWorkerRegistration>(() => undefined),
    register: () => Promise.resolve({ active, installing, waiting: null, update: () => Promise.resolve() }),
  } as unknown as ServiceWorkerContainer;
  return { container, events };
}

/** The errors captured as issues until the spec ends. */
function recordCaptures(): unknown[] {
  const captured: unknown[] = [];
  onTestFinished(
    bindCaptureSink({
      exception: error => {
        captured.push(error);
      },
      expected: () => undefined,
    }),
  );
  return captured;
}

describe('registerAppServiceWorker', () => {
  it('As a visitor after a deploy, I open the product on an outdated service worker and it updates with a reload offered to me', async () => {
    // Given a page controlled by a worker from the build before
    const update = vi.fn(() => Promise.resolve());
    const container = createControlledContainer({ active: createWorkerAt('old-build'), update });
    const offered = createDeferred<undefined>();
    const appWorker: AppServiceWorker = {
      container,
      version: 'new-build',
      offerReload: () => {
        offered.resolve(undefined);
      },
    };

    // When
    await registerAppServiceWorker(appWorker);
    await offered.promise;

    // Then
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('As a visitor after a full reset, I wait for the fresh worker and no listener is left once it takes control', async () => {
    // Given a page whose fresh worker has not taken control yet
    const { container, events } = createFreshContainer();
    const registered = registerAppServiceWorker(
      { container, version: undefined, offerReload: () => undefined },
      { waitForFreshController: true },
    );
    await events.listened;

    // When the fresh worker takes control
    events.dispatchEvent(new Event('controllerchange'));
    await registered;

    // Then
    expect(events.countListening()).toBe(0);
  });

  it('As a visitor after a full reset in a browser that kept the worker, I go on at once and no failure is reported', async () => {
    // Given a page whose worker the browser kept through the reset, with nothing installing or waiting
    const logs = recordLog({ onFinished: onTestFinished, level: 'error' });
    const sentry = bindRecordingSentry({ onFinished: onTestFinished });
    const kept = createWorkerAt('build-1');
    const { container, events } = createFreshContainer({ controller: kept, active: kept });

    // When it registers on the reset path, on timers that never run
    await registerAppServiceWorker(
      { container, version: undefined, offerReload: () => undefined },
      { waitForFreshController: true, timers: createManualTimers() },
    );

    // Then
    expect(events.countListening()).toBe(0);
    expect(logs).toEqual([]);
    expect(sentry.counted('sandbox.sw_register')).toEqual([]);
  });

  it('As a visitor after a full reset with a new worker installing, I wait for it to take control', async () => {
    // Given a page controlled by the old worker, whose registration has a new worker installing
    const old = createWorkerAt('build-1');
    const { container, events } = createFreshContainer({
      controller: old,
      active: old,
      installing: createWorkerAt('build-2'),
    });
    const registered = registerAppServiceWorker(
      { container, version: undefined, offerReload: () => undefined },
      { waitForFreshController: true, timers: createManualTimers() },
    );
    await events.listened;

    // When the new worker takes control
    events.dispatchEvent(new Event('controllerchange'));
    await registered;

    // Then
    expect(events.countListening()).toBe(0);
  });

  it('As an operator, I watch the browser refuse the registration and see it logged and counted by its error name while the page goes on', async () => {
    // Given a browser that refuses to register the worker
    const logs = recordLog({ onFinished: onTestFinished, level: 'error' });
    const sentry = bindRecordingSentry({ onFinished: onTestFinished });
    const refusal = new TypeError('Failed to register a ServiceWorker');
    // The registration reads only these two members.
    const container = {
      controller: null,
      register: () => Promise.reject(refusal),
    } as unknown as ServiceWorkerContainer;

    // When
    await registerAppServiceWorker({ container, version: undefined, offerReload: () => undefined });

    // Then
    expect(logs.map(line => line.args)).toEqual([
      ['[dot.li app] Service worker registration failed; continuing without one:', refusal],
    ]);
    expect(sentry.counted('sandbox.sw_register')).toEqual([{ outcome: 'error', reason: 'TypeError' }]);
  });

  it('As an operator, I watch a browser that allows no service worker refuse the registration and it is counted as expected, never captured', async () => {
    // Given a browser that refuses service workers on this origin, as a private window does
    const captured = recordCaptures();
    const sentry = bindRecordingSentry({ onFinished: onTestFinished });
    const refusal = new DOMException('The operation is insecure.', 'SecurityError');
    // The registration reads only these two members.
    const container = {
      controller: null,
      register: () => Promise.reject(refusal),
    } as unknown as ServiceWorkerContainer;

    // When
    await registerAppServiceWorker({ container, version: undefined, offerReload: () => undefined });

    // Then
    expect(captured).toEqual([]);
    expect(sentry.counted('sandbox.sw_register')).toEqual([{ outcome: 'error', reason: 'SecurityError' }]);
  });

  it('As an operator, I watch a slow worker miss its time to take control and it is counted as expected, never captured', async () => {
    // Given a page whose fresh worker never takes control
    const captured = recordCaptures();
    const sentry = bindRecordingSentry({ onFinished: onTestFinished });
    const timers = createManualTimers();
    const { container, events } = createFreshContainer();
    const registered = registerAppServiceWorker(
      { container, version: undefined, offerReload: () => undefined },
      { waitForFreshController: true, timers },
    );
    await events.listened;

    // When its time runs out
    await timers.advance(SANDBOX_TIMEOUTS.SW_READY);
    await registered;

    // Then
    expect(captured).toEqual([]);
    expect(sentry.counted('sandbox.sw_register')).toEqual([
      { outcome: 'error', reason: 'ServiceWorkerControlTimeoutError' },
    ]);
  });

  it('As an operator, I watch a fresh worker refuse the prod to take control and see it counted while the page goes on', async () => {
    // Given a page whose fresh worker is already redundant, so it refuses every post
    const sentry = bindRecordingSentry({ onFinished: onTestFinished });
    const redundant = createUnreachableWorker(new DOMException('The worker is redundant', 'InvalidStateError'));
    const { container } = createFreshContainer();
    Object.defineProperty(container, 'ready', { value: Promise.resolve({ active: redundant }) });

    // When it registers on the reset path
    await registerAppServiceWorker(
      { container, version: undefined, offerReload: () => undefined },
      { waitForFreshController: true, timers: createManualTimers() },
    );

    // Then
    expect(sentry.counted('sandbox.sw_register')).toEqual([{ outcome: 'error', reason: 'InvalidStateError' }]);
  });

  it('As an operator, I watch an outdated worker fail its update for no known reason and see it logged and counted by its error name', async () => {
    // Given a page controlled by a worker from the build before, whose update fails unexpectedly
    const logs = recordLog({ onFinished: onTestFinished, level: 'error' });
    const counted = createDeferred<undefined>();
    const sentry = bindRecordingSentry({
      onFinished: onTestFinished,
      onRecord: () => {
        counted.resolve(undefined);
      },
    });
    const failure = new RangeError('the update broke');
    const container = createControlledContainer({
      active: createWorkerAt('old-build'),
      update: () => Promise.reject(failure),
    });

    // When the page registers, and the update's failure is counted
    await registerAppServiceWorker({ container, version: 'new-build', offerReload: () => undefined });
    await counted.promise;

    // Then
    expect(logs.map(line => line.args)).toEqual([['[dot.li app] Service worker update failed:', failure]]);
    expect(sentry.counted('sandbox.sw_update')).toEqual([{ outcome: 'error', reason: 'RangeError' }]);
  });

  it.each([
    ['TypeError', new TypeError('the update was refused')],
    ['InvalidStateError', new DOMException('the update was refused', 'InvalidStateError')],
  ])(
    'As an operator, I watch the browser refuse an update with %s and it is counted as expected under the service worker update metric',
    async (name, refusal) => {
      // Given a page controlled by a worker from the build before, whose update the browser refuses as expected
      const captured = recordCaptures();
      const counted = createDeferred<undefined>();
      const sentry = bindRecordingSentry({
        onFinished: onTestFinished,
        onRecord: () => {
          counted.resolve(undefined);
        },
      });
      const container = createControlledContainer({
        active: createWorkerAt('old-build'),
        update: () => Promise.reject(refusal),
      });

      // When the page registers, and the refusal is counted
      await registerAppServiceWorker({ container, version: 'new-build', offerReload: () => undefined });
      await counted.promise;

      // Then it is counted by its name and no exception is captured
      expect(sentry.counted('sandbox.sw_update')).toEqual([{ outcome: 'error', reason: name }]);
      expect(captured).toEqual([]);
    },
  );

  it('As an operator, I watch a worker that cannot take the version check fail it and see it logged and counted by its error name', async () => {
    // Given a page controlled by a worker that throws on every post
    const logs = recordLog({ onFinished: onTestFinished, level: 'error' });
    const counted = createDeferred<undefined>();
    const sentry = bindRecordingSentry({
      onFinished: onTestFinished,
      onRecord: () => {
        counted.resolve(undefined);
      },
    });
    const failure = new DOMException('The worker is redundant', 'InvalidStateError');
    const update = vi.fn(() => Promise.resolve());
    const container = createControlledContainer({ active: createUnreachableWorker(failure), update });

    // When the page registers, and the failed check is counted
    await registerAppServiceWorker({ container, version: 'new-build', offerReload: () => undefined });
    await counted.promise;

    // Then nothing is updated, and the failure is reported once
    expect(update).not.toHaveBeenCalled();
    expect(logs.map(line => line.args)).toEqual([['[dot.li app] Service worker freshness check failed:', failure]]);
    expect(sentry.counted('sandbox.sw_update')).toEqual([{ outcome: 'error', reason: 'InvalidStateError' }]);
  });
});
