// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { bindCaptureSink, spans as S } from '@dotli/metrics';
import { bindRecordingSentry } from '@dotli/metrics/testing';
import { createDeferred } from '@dotli/shared';
import { recordLog } from '@dotli/shared/testing';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { registerAppServiceWorker, type AppServiceWorker } from './registerAppServiceWorker.js';
import { createCountingEventTarget } from './testing/createCountingEventTarget.js';

type CreateControlledContainerParams = {
  /** The worker that controls the page and that the registration holds. */
  active: ServiceWorker;
  /** The registration's update of that worker. */
  update: () => Promise<void>;
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

/** A page no worker controls yet, counting the `controllerchange` listeners still attached. */
function createFreshContainer() {
  const events = createCountingEventTarget({ type: 'controllerchange' });
  // The wait for a fresh worker reads only these members of the container.
  const container = {
    ...events,
    controller: null,
    ready: new Promise<ServiceWorkerRegistration>(() => undefined),
    register: () => Promise.resolve({ active: null, update: () => Promise.resolve() }),
  } as unknown as ServiceWorkerContainer;
  return { container, events };
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
    expect(sentry.counted(S.SANDBOX_SW_REGISTER)).toEqual([{ outcome: 'error', reason: 'TypeError' }]);
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
    expect(sentry.counted(S.SANDBOX_SW_UPDATE)).toEqual([{ outcome: 'error', reason: 'RangeError' }]);
  });

  it.each([
    ['TypeError', new TypeError('the update was refused')],
    ['InvalidStateError', new DOMException('the update was refused', 'InvalidStateError')],
  ])(
    'As an operator, I watch the browser refuse an update with %s and it is counted as expected under the service worker update metric',
    async (name, refusal) => {
      // Given a page controlled by a worker from the build before, whose update the browser refuses as expected
      const captured: unknown[] = [];
      onTestFinished(
        bindCaptureSink({
          exception: error => {
            captured.push(error);
          },
          expected: () => undefined,
        }),
      );
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
      expect(sentry.counted(S.SANDBOX_SW_UPDATE)).toEqual([{ outcome: 'error', reason: name }]);
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
    expect(sentry.counted(S.SANDBOX_SW_UPDATE)).toEqual([{ outcome: 'error', reason: 'InvalidStateError' }]);
  });
});
