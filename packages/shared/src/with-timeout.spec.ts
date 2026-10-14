// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withTimeout } from './with-timeout.js';

class SlowError extends Error {}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('withTimeout', () => {
  it('As a caller whose work never settles, I get the error I named once the time is up', async () => {
    // Given
    const timed = withTimeout(new Promise<never>(() => undefined), 1_000, () => new SlowError('too slow'));
    const settled = expect(timed).rejects.toBeInstanceOf(SlowError);

    // When
    await vi.advanceTimersByTimeAsync(1_000);

    // Then
    await settled;
  });

  it("As a caller whose work settles in time, I get the work's value and leave no timer running", async () => {
    // When
    const value = await withTimeout(Promise.resolve(7), 1_000, () => new SlowError('too slow'));

    // Then
    expect(value).toBe(7);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("As a caller whose work fails first, I get the work's error and leave no timer running", async () => {
    // Given
    const failure = new Error('read failed');

    // When
    const timed = withTimeout(Promise.reject(failure), 1_000, () => new SlowError('too slow'));

    // Then
    await expect(timed).rejects.toBe(failure);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('As two callers sharing one piece of work, the tighter budget fails and the looser one still gets the value', async () => {
    // Given
    let resolve: (value: number) => void = () => undefined;
    const work = new Promise<number>(done => {
      resolve = done;
    });
    const tight = withTimeout(work, 1_000, () => new SlowError('tight'));
    const loose = withTimeout(work, 5_000, () => new SlowError('loose'));
    const tightSettled = expect(tight).rejects.toBeInstanceOf(SlowError);

    // When
    await vi.advanceTimersByTimeAsync(1_000);
    resolve(3);

    // Then
    await tightSettled;
    await expect(loose).resolves.toBe(3);
  });
});
