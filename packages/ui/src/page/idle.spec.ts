// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { bindCaptureSink, type CaptureContext } from '@dotli/metrics';
import { bindRecordingSentry } from '@dotli/metrics/testing';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { preloadWhenIdle, type IdleScheduler } from './idle.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('preloadWhenIdle', () => {
  it('As the shell, a chunk preloads once the browser is idle', () => {
    // Given
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
    preloadWhenIdle({ preload }, scheduler);

    // Then
    expect(preload).not.toHaveBeenCalled();
    idle?.();
    expect(preload).toHaveBeenCalledTimes(1);
  });

  it('As the shell on a browser without idle callbacks, a chunk preloads after 2 s', () => {
    // Given
    vi.useFakeTimers();
    const preload = vi.fn(() => Promise.resolve());

    // When
    preloadWhenIdle({ preload }, {});
    vi.advanceTimersByTime(1999);

    // Then
    expect(preload).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(preload).toHaveBeenCalledTimes(1);
  });

  it('As the shell somewhere with idle callbacks but no way to cancel them, a chunk preloads after 2 s', () => {
    // Given
    vi.useFakeTimers();
    const preload = vi.fn(() => Promise.resolve());

    // When
    const cancel = preloadWhenIdle({ preload }, { requestIdleCallback: () => 1 });
    vi.advanceTimersByTime(2000);
    cancel();

    // Then
    expect(preload).toHaveBeenCalledTimes(1);
  });

  it('As the shell, cancelling works with the idle API it scheduled on, whatever the page did to it since', () => {
    // Given
    const cancelIdle = vi.fn();
    const scheduler: IdleScheduler = { requestIdleCallback: () => 7, cancelIdleCallback: cancelIdle };
    const cancel = preloadWhenIdle({ preload: () => Promise.resolve() }, scheduler);

    // When
    scheduler.cancelIdleCallback = undefined;
    cancel();

    // Then
    expect(cancelIdle).toHaveBeenCalledWith(7);
  });

  it('As the shell offline, a failed preload is left to the first open and counted once as an expected miss, not an issue', async () => {
    // Given a browser that cannot fetch the chunk, and a fake Sentry that records
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const exception = vi.fn();
    const missed = Promise.withResolvers<{ error: unknown; ctx: Pick<CaptureContext, 'flow' | 'step'> }>();
    onTestFinished(
      bindCaptureSink({
        exception,
        expected: (error, ctx) => {
          missed.resolve({ error, ctx });
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
    preloadWhenIdle({ preload: () => Promise.reject(offline) }, scheduler);

    // When
    idle?.();

    // Then
    await expect(missed.promise).resolves.toEqual({ error: offline, ctx: { flow: 'ui', step: 'idle_preload' } });
    expect(metrics.counted('lazy_chunk.load')).toEqual([{ outcome: 'error', reason: 'idle_preload' }]);
    expect(exception).not.toHaveBeenCalled();
  });

  it('As the shell, a cancelled preload never runs', async () => {
    // Given
    vi.useFakeTimers();
    const cancelled = vi.fn(() => Promise.resolve());

    // When
    const cancel = preloadWhenIdle({ preload: cancelled }, {});
    cancel();
    await vi.advanceTimersByTimeAsync(2000);

    // Then
    expect(cancelled).not.toHaveBeenCalled();
  });
});
