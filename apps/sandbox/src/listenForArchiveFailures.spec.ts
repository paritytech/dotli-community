// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished } from 'vitest';
import { bindCaptureSink } from '@dotli/metrics';
import { catchError } from '@dotli/shared/testing';

import { APP_SERVICE_WORKER_MESSAGES } from './appServiceWorkerMessages.js';
import { listenForArchiveFailures } from './listenForArchiveFailures.js';
import { createCountingEventTarget } from './testing/createCountingEventTarget.js';

/** A worker's report that restoring the archive failed because the origin's quota is full. */
function createRestoreFailure(): MessageEvent {
  return new MessageEvent('message', {
    data: {
      type: APP_SERVICE_WORKER_MESSAGES.ARCHIVE_FAILURE,
      stage: 'restore',
      name: 'QuotaExceededError',
      message: 'full',
    },
  });
}

/** Records the step of each failure captured until the test finishes. */
function recordCapturedSteps(): string[] {
  const steps: string[] = [];
  onTestFinished(
    bindCaptureSink({
      exception: (_error, context) => {
        steps.push(context.step);
      },
      expected: () => undefined,
    }),
  );
  return steps;
}

describe('listenForArchiveFailures', () => {
  it('As a sandbox page, I hear an archive failure the worker reports and capture it', () => {
    // Given a page listening to its service worker
    const steps = recordCapturedSteps();
    const container = createCountingEventTarget({ type: 'message' });
    listenForArchiveFailures(container);

    // When the worker reports a failed restore
    container.dispatchEvent(createRestoreFailure());

    // Then the failure is captured once as a restore step
    expect(steps).toEqual(['sw_restore']);
  });

  it('As a sandbox page, I hear the worker fail to serve a fetch and capture it as a serving step', () => {
    // Given a page listening to its service worker
    const steps = recordCapturedSteps();
    const container = createCountingEventTarget({ type: 'message' });
    listenForArchiveFailures(container);

    // When the worker reports a failure to serve
    container.dispatchEvent(
      new MessageEvent('message', {
        data: { type: APP_SERVICE_WORKER_MESSAGES.ARCHIVE_FAILURE, stage: 'serve', name: 'InvalidStateError' },
      }),
    );

    // Then
    expect(steps).toEqual(['sw_serve']);
  });

  it('As a sandbox page that stopped listening, I hear a failure the worker reports and capture nothing', () => {
    // Given a page that listened to its service worker and stopped
    const steps = recordCapturedSteps();
    const container = createCountingEventTarget({ type: 'message' });
    const stop = listenForArchiveFailures(container);
    stop();

    // When the worker reports a failed restore
    container.dispatchEvent(createRestoreFailure());

    // Then nothing is captured and no listener is left on the worker's container
    expect(steps).toEqual([]);
    expect(container.countListening()).toBe(0);
  });

  it('As a sandbox page that stopped listening, I stop again and nothing throws', () => {
    // Given a page that listened to its service worker and stopped
    const container = createCountingEventTarget({ type: 'message' });
    const stop = listenForArchiveFailures(container);
    stop();

    // When the page stops again
    const thrown = catchError(stop);

    // Then nothing threw and no listener is left
    expect(thrown).toBeUndefined();
    expect(container.countListening()).toBe(0);
  });

  it('As a sandbox page that listened twice and stopped one, I hear a failure the worker reports and capture it once', () => {
    // Given two listens on one service worker container, one of them stopped
    const steps = recordCapturedSteps();
    const container = createCountingEventTarget({ type: 'message' });
    const stopFirst = listenForArchiveFailures(container);
    listenForArchiveFailures(container);
    stopFirst();

    // When the worker reports a failed restore
    container.dispatchEvent(createRestoreFailure());

    // Then the listen that stayed captured it once
    expect(steps).toEqual(['sw_restore']);
    expect(container.countListening()).toBe(1);
  });

  it('As a sandbox page without a service worker, I stop listening and nothing throws', () => {
    // Given a page with no service worker container
    const stop = listenForArchiveFailures(null);

    // When the page stops listening
    const thrown = catchError(stop);

    // Then nothing threw
    expect(thrown).toBeUndefined();
  });
});
