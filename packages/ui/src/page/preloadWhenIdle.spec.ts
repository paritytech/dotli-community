// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { bindCaptureSink, type CaptureContext } from '@dotli/metrics';
import { bindRecordingSentry } from '@dotli/metrics/testing';
import { createDeferred } from '@dotli/shared';
import { createManualTimers } from '@dotli/shared/testing';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { preloadWhenIdle } from './preloadWhenIdle.js';
import type { IdleScheduler } from './runWhenIdle.js';

describe('preloadWhenIdle', () => {
  it('As the shell, I preload a chunk and it loads once the browser is idle', () => {
    // Given a browser that offers idle callbacks
    let idle: (() => void) | undefined;
    const scheduler: IdleScheduler = {
      requestIdleCallback: run => {
        idle = run;
        return 1;
      },
      cancelIdleCallback: () => undefined,
    };
    const preload = vi.fn(() => Promise.resolve());

    // When
    preloadWhenIdle({ preload }, { scheduler });
    const beforeIdle = preload.mock.calls.length;
    idle?.();

    // Then
    expect(beforeIdle).toBe(0);
    expect(preload).toHaveBeenCalledTimes(1);
  });

  it('As the shell on a browser without idle callbacks, I preload a chunk and it loads after 2 s', async () => {
    // Given
    const timers = createManualTimers();
    const preload = vi.fn(() => Promise.resolve());

    // When
    preloadWhenIdle({ preload }, { scheduler: {}, timers });
    await timers.advance(1999);
    const beforeDeadline = preload.mock.calls.length;
    await timers.advance(1);

    // Then
    expect(beforeDeadline).toBe(0);
    expect(preload).toHaveBeenCalledTimes(1);
  });

  it('As the shell somewhere with idle callbacks but no way to cancel them, I preload a chunk and it loads after 2 s', async () => {
    // Given
    const timers = createManualTimers();
    const preload = vi.fn(() => Promise.resolve());

    // When
    const cancel = preloadWhenIdle({ preload }, { scheduler: { requestIdleCallback: () => 1 }, timers });
    await timers.advance(2000);
    cancel();

    // Then
    expect(preload).toHaveBeenCalledTimes(1);
  });

  it('As the shell, I cancel a preload and the cancel reaches the idle API it scheduled on, whatever the page did to it since', () => {
    // Given a preload scheduled on an idle API the page then takes the cancel from
    const cancelIdle = vi.fn();
    const scheduler: IdleScheduler = { requestIdleCallback: () => 7, cancelIdleCallback: cancelIdle };
    const cancel = preloadWhenIdle({ preload: () => Promise.resolve() }, { scheduler });
    scheduler.cancelIdleCallback = undefined;

    // When
    cancel();

    // Then
    expect(cancelIdle).toHaveBeenCalledWith(7);
  });

  it('As the shell offline, I preload a chunk that fails and it is left to the first open and counted once as an expected miss, not an issue', async () => {
    // Given a browser that cannot fetch the chunk, and a fake Sentry that records
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const exception = vi.fn();
    const missed = createDeferred<{ error: unknown; context: Pick<CaptureContext, 'flow' | 'step'> }>();
    onTestFinished(
      bindCaptureSink({
        exception,
        expected: (error, context) => {
          missed.resolve({ error, context });
        },
      }),
    );
    const offline = new TypeError('Failed to fetch dynamically imported module');
    let idle: (() => void) | undefined;
    const scheduler: IdleScheduler = {
      requestIdleCallback: run => {
        idle = run;
        return 1;
      },
      cancelIdleCallback: () => undefined,
    };
    preloadWhenIdle({ preload: () => Promise.reject(offline) }, { scheduler });

    // When the browser goes idle and the preload fails
    idle?.();
    const reported = await missed.promise;

    // Then
    expect(reported).toMatchObject({ error: offline, context: { step: 'idle_preload' } });
    expect(metrics.counted('lazy_chunk.load')).toEqual([{ outcome: 'error', reason: 'idle_preload' }]);
    expect(exception).not.toHaveBeenCalled();
  });

  it('As the shell, I cancel a preload before the deadline and it never runs', async () => {
    // Given
    const timers = createManualTimers();
    const cancelled = vi.fn(() => Promise.resolve());

    // When
    const cancel = preloadWhenIdle({ preload: cancelled }, { scheduler: {}, timers });
    cancel();
    await timers.advance(2000);

    // Then
    expect(cancelled).not.toHaveBeenCalled();
  });
});
