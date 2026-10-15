// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { sleep } from './sleep.js';
import { manualTimers } from './testing/manual-timers.js';
import type { Timers } from './timers.js';

/** Manual timers that count the timers still waiting, so a spec sees whether a wait left one behind. */
function countingTimers(): { timers: Timers & { advance: (ms: number) => Promise<void> }; pending: () => number } {
  const inner = manualTimers();
  const live = new Set<unknown>();
  const timers = {
    ...inner,
    setTimeout: (callback: () => void, ms: number): unknown => {
      const handle = inner.setTimeout(() => {
        live.delete(handle);
        callback();
      }, ms);
      live.add(handle);
      return handle;
    },
    clearTimeout: (handle: unknown): void => {
      live.delete(handle);
      inner.clearTimeout(handle);
    },
  };
  return { timers, pending: () => live.size };
}

describe('sleep', () => {
  it('As a caller that waits out an interval, I resume once the time is up', async () => {
    // Given
    const { timers } = countingTimers();
    let woke = false;
    void sleep(1_000, undefined, timers).then(() => {
      woke = true;
    });

    // When
    await timers.advance(999);

    // Then
    expect(woke).toBe(false);

    // When
    await timers.advance(1);

    // Then
    expect(woke).toBe(true);
  });

  it('As a caller whose task is aborted, my wait ends at once with an AbortError and leaves no timer', async () => {
    // Given
    const { timers, pending } = countingTimers();
    const controller = new AbortController();
    const wait = sleep(1_000, controller.signal, timers);
    const ended = expect(wait).rejects.toMatchObject({ name: 'AbortError' });

    // When
    controller.abort();

    // Then
    await ended;
    expect(pending()).toBe(0);
  });

  it('As a caller with an aborted signal, I never start the wait', async () => {
    // Given
    const { timers, pending } = countingTimers();
    const controller = new AbortController();
    controller.abort();

    // When
    const wait = sleep(1_000, controller.signal, timers);

    // Then
    await expect(wait).rejects.toMatchObject({ name: 'AbortError' });
    expect(pending()).toBe(0);
  });
});
