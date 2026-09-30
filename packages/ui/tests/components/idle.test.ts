// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from 'vitest';
import { preloadWhenIdle } from '../../src/components/idle.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('preloadWhenIdle', () => {
  it('As the shell, a chunk preloads once the browser is idle', () => {
    // Given
    let idle: (() => void) | undefined;
    vi.stubGlobal('requestIdleCallback', (run: () => void) => {
      idle = run;
      return 1;
    });
    vi.stubGlobal('cancelIdleCallback', () => undefined);
    const preload = vi.fn(() => Promise.resolve());

    // When
    preloadWhenIdle({ preload });

    // Then
    expect(preload).not.toHaveBeenCalled();
    idle?.();
    expect(preload).toHaveBeenCalledTimes(1);
  });

  it('As the shell on a browser without idle callbacks, a chunk preloads after 2 s', () => {
    // Given
    vi.useFakeTimers();
    vi.stubGlobal('requestIdleCallback', undefined);
    const preload = vi.fn(() => Promise.resolve());

    // When
    preloadWhenIdle({ preload });
    vi.advanceTimersByTime(1999);

    // Then
    expect(preload).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(preload).toHaveBeenCalledTimes(1);
  });

  it('As the shell somewhere with idle callbacks but no way to cancel them, a chunk preloads after 2 s', () => {
    // Given
    vi.useFakeTimers();
    vi.stubGlobal('requestIdleCallback', () => 1);
    vi.stubGlobal('cancelIdleCallback', undefined);
    const preload = vi.fn(() => Promise.resolve());

    // When
    const cancel = preloadWhenIdle({ preload });
    vi.advanceTimersByTime(2000);
    cancel();

    // Then
    expect(preload).toHaveBeenCalledTimes(1);
  });

  it('As the shell, a failed preload is left to the first open, and a cancelled one never runs', async () => {
    // Given
    vi.useFakeTimers();
    vi.stubGlobal('requestIdleCallback', undefined);
    const failing = vi.fn(() => Promise.reject(new Error('offline')));
    const cancelled = vi.fn(() => Promise.resolve());

    // When
    preloadWhenIdle({ preload: failing });
    const cancel = preloadWhenIdle({ preload: cancelled });
    cancel();
    await vi.advanceTimersByTimeAsync(2000);

    // Then: no unhandled rejection, and the cancelled one did not run.
    expect(failing).toHaveBeenCalledTimes(1);
    expect(cancelled).not.toHaveBeenCalled();
  });
});
