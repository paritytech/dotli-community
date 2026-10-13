// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReportFailure } from '../report.js';
import { createLazyRoot } from './lazy-root.js';

const report = vi.fn<ReportFailure>();

beforeEach(() => {
  report.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createLazyRoot', () => {
  it('As a loader, ensure loads and mounts once, however often it is called', async () => {
    // Given
    const load = vi.fn(() => Promise.resolve());
    const root = createLazyRoot({ load, root: 'x', report, onFailure: vi.fn() });

    // When
    await Promise.all([root.ensure(), root.ensure()]);
    await root.ensure();

    // Then
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('As a loader, an ensure made while the root mounts waits for that mount', async () => {
    // Given
    const mount: PromiseWithResolvers<void> = Promise.withResolvers();
    const load = vi.fn(() => mount.promise);
    const root = createLazyRoot({ load, root: 'x', report, onFailure: vi.fn() });
    const first = root.ensure();
    let secondDone = false;
    const second = root.ensure().then(() => {
      secondDone = true;
    });
    // More microtask turns than an ensure that skipped the wait would need to settle.
    for (let turn = 0; turn < 10; turn += 1) {
      await Promise.resolve();
    }

    // Then
    expect(secondDone).toBe(false);

    // When
    mount.resolve();
    await Promise.all([first, second]);

    // Then
    expect(secondDone).toBe(true);
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
      report,
      onFailure,
    });

    // When
    await expect(root.ensure()).resolves.toBeUndefined();

    // Then
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(failure, {
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
      report,
      onFailure,
    });

    // When
    await root.ensure();

    // Then
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ message: 'container missing' }), {
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
    const root = createLazyRoot({ load, root: 'x', report, onFailure });
    await root.ensure();

    // When
    onBroken();

    // Then
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(report).not.toHaveBeenCalled();

    // When
    await root.ensure();

    // Then
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('As a loader, a root that broke while it still mounted is mounted afresh by the next ensure', async () => {
    // Given
    const onFailure = vi.fn();
    const load = vi
      .fn<(onBroken: () => void) => Promise<unknown>>()
      .mockImplementationOnce(broken =>
        Promise.resolve().then(() => {
          broken();
        }),
      )
      .mockResolvedValueOnce(undefined);
    const root = createLazyRoot({ load, root: 'x', report, onFailure });
    await root.ensure();

    // When
    await root.ensure();

    // Then
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('As a loader, prefetch mounts the root when the browser goes idle', async () => {
    // Given
    let idle: (() => void) | null = null;
    const requestIdleCallback = vi.fn((cb: () => void, options: { timeout: number }) => {
      idle = cb;
      return options.timeout;
    });
    const load = vi.fn(() => Promise.resolve());
    const root = createLazyRoot({
      load,
      root: 'x',
      report,
      onFailure: vi.fn(),
      idle: { requestIdleCallback, cancelIdleCallback: vi.fn() },
    });

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
    const load = vi.fn(() => Promise.resolve());
    const root = createLazyRoot({ load, root: 'x', report, onFailure: vi.fn(), idle: {} });

    // When
    root.prefetch();
    vi.advanceTimersByTime(1999);

    // Then
    expect(load).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(load).toHaveBeenCalledTimes(1);
  });
});
