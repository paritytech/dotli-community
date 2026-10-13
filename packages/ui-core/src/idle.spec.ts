// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRecordingReporter } from './report.fake.js';
import type { Reporter } from './report.js';
import { preloadWhenIdle, type IdleScheduler } from './idle.js';

const reporter = createRecordingReporter();

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
    preloadWhenIdle({ preload }, reporter, scheduler);

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
    preloadWhenIdle({ preload }, reporter, {});
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
    const cancel = preloadWhenIdle({ preload }, reporter, { requestIdleCallback: () => 1 });
    vi.advanceTimersByTime(2000);
    cancel();

    // Then
    expect(preload).toHaveBeenCalledTimes(1);
  });

  it('As the shell, cancelling works with the idle API it scheduled on, whatever the page did to it since', () => {
    // Given
    const cancelIdle = vi.fn();
    const scheduler: IdleScheduler = { requestIdleCallback: () => 7, cancelIdleCallback: cancelIdle };
    const cancel = preloadWhenIdle({ preload: () => Promise.resolve() }, reporter, scheduler);

    // When
    scheduler.cancelIdleCallback = undefined;
    cancel();

    // Then
    expect(cancelIdle).toHaveBeenCalledWith(7);
  });

  it('As the shell offline, a failed preload is left to the first open and recorded once as an expected miss, not an issue', async () => {
    // Given a browser that cannot fetch the chunk, and a reporter that records and signals the miss
    const offline = new TypeError('Failed to fetch dynamically imported module');
    const recorded = createRecordingReporter();
    const missed = Promise.withResolvers<undefined>();
    const recording: Reporter = {
      ...recorded,
      expected: (error, context) => {
        recorded.expected(error, context);
        missed.resolve(undefined);
      },
    };
    let idle: (() => void) | undefined;
    const scheduler: IdleScheduler = {
      requestIdleCallback: run => {
        idle = run;
        return 1;
      },
      cancelIdleCallback: () => undefined,
    };
    preloadWhenIdle({ preload: () => Promise.reject(offline) }, recording, scheduler);

    // When
    idle?.();

    // Then it is recorded once as an expected miss with the preload as its reason, and never as a failure
    await missed.promise;
    expect(recorded.misses).toEqual([
      { error: offline, context: { flow: 'ui', step: 'idle_preload', reason: 'idle_preload' } },
    ]);
    expect(recorded.failures).toEqual([]);
  });

  it('As the shell, a cancelled preload never runs', async () => {
    // Given
    vi.useFakeTimers();
    const cancelled = vi.fn(() => Promise.resolve());

    // When
    const cancel = preloadWhenIdle({ preload: cancelled }, reporter, {});
    cancel();
    await vi.advanceTimersByTimeAsync(2000);

    // Then
    expect(cancelled).not.toHaveBeenCalled();
  });
});
