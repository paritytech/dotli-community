// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock('../../../metrics/src/sentry.js', () => sentry);

import { createLazyRoot } from '../../src/mount/lazy-root.js';

beforeEach(() => {
  sentry.captureException.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('createLazyRoot', () => {
  it('As a loader, ensure loads and mounts once, however often it is called', async () => {
    // Given
    const load = vi.fn(() => Promise.resolve());
    const root = createLazyRoot({ load, root: 'x', onFailure: vi.fn() });

    // When
    const first = root.ensure();
    const second = root.ensure();
    await first;
    await root.ensure();

    // Then
    expect(second).toBe(first);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('As a loader, a chunk that cannot load is reported, falls back and never rejects, and the next ensure retries', async () => {
    // Given
    const failure = new Error('chunk failed');
    const load = vi
      .fn<(onBroken: () => void) => Promise<unknown>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(undefined);
    const onFailure = vi.fn();
    const root = createLazyRoot({
      load,
      root: 'thing',
      onFailure,
    });

    // When
    await expect(root.ensure()).resolves.toBeUndefined();

    // Then
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    expect(sentry.captureException).toHaveBeenCalledWith(failure, {
      flow: 'ui',
      step: 'root_load',
      tags: { root: 'thing', kind: 'thing_load_error' },
    });
    expect(onFailure).toHaveBeenCalledTimes(1);

    // When
    await root.ensure();

    // Then
    expect(load).toHaveBeenCalledTimes(2);
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  it('As a loader, a mount that throws is reported and falls back like a failed load', async () => {
    // Given
    const onFailure = vi.fn();
    const root = createLazyRoot({
      load: () =>
        Promise.resolve().then(() => {
          throw new Error('container missing');
        }),
      root: 'thing',
      onFailure,
    });

    // When
    await root.ensure();

    // Then
    expect(sentry.captureException).toHaveBeenCalledWith(expect.objectContaining({ message: 'container missing' }), {
      flow: 'ui',
      step: 'root_load',
      tags: { root: 'thing', kind: 'thing_load_error' },
    });
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  it('As a loader, a root that broke falls back, is not reported again here, and the next ensure mounts afresh', async () => {
    // Given
    let onBroken = (): void => {};
    const load = vi.fn((broken: () => void) => {
      onBroken = broken;
      return Promise.resolve();
    });
    const onFailure = vi.fn();
    const root = createLazyRoot({ load, root: 'x', onFailure });
    await root.ensure();

    // When
    onBroken();

    // Then
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(sentry.captureException).not.toHaveBeenCalled();

    // When
    await root.ensure();

    // Then
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('As a loader, prefetch mounts the root when the browser goes idle', async () => {
    // Given
    let idle: (() => void) | null = null;
    const requestIdleCallback = vi.fn((cb: () => void, options: { timeout: number }) => {
      idle = cb;
      return options.timeout;
    });
    vi.stubGlobal('requestIdleCallback', requestIdleCallback);
    const load = vi.fn(() => Promise.resolve());
    const root = createLazyRoot({ load, root: 'x', onFailure: vi.fn() });

    // When
    root.prefetch();

    // Then nothing loads until the browser is idle
    expect(load).not.toHaveBeenCalled();
    expect(requestIdleCallback).toHaveBeenCalledWith(expect.any(Function), {
      timeout: 2000,
    });

    // When
    (idle as unknown as () => void)();
    await root.ensure();

    // Then
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('As a loader, prefetch falls back to a 2 s timer without requestIdleCallback', () => {
    // Given
    vi.useFakeTimers();
    vi.stubGlobal('requestIdleCallback', undefined);
    const load = vi.fn(() => Promise.resolve());
    const root = createLazyRoot({ load, root: 'x', onFailure: vi.fn() });

    // When
    root.prefetch();
    vi.advanceTimersByTime(1999);

    // Then
    expect(load).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(load).toHaveBeenCalledTimes(1);
  });
});
