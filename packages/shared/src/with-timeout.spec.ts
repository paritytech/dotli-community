// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { manualTimers } from './testing/manual-timers.js';
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

  it('As a caller whose error factory throws a string, I get an Error that keeps the string as its cause', async () => {
    // Given
    const timed = withTimeout(new Promise<never>(() => undefined), 1_000, () => {
      // eslint-disable-next-line no-throw-literal, @typescript-eslint/only-throw-error -- the case under test is a non-Error throw
      throw 'plain string';
    });
    const settled = expect(timed).rejects.toMatchObject({ cause: 'plain string' });

    // When
    await vi.advanceTimersByTimeAsync(1_000);

    // Then
    await settled;
    await expect(timed).rejects.toBeInstanceOf(Error);
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

  it('As a caller whose timeout error cannot be made, I still get an answer: what stopped it', async () => {
    // Given
    const broken = new TypeError('the abort could not be posted');
    const timed = withTimeout(new Promise<never>(() => undefined), 1_000, () => {
      throw broken;
    });
    const settled = expect(timed).rejects.toBe(broken);

    // When
    await vi.advanceTimersByTimeAsync(1_000);

    // Then
    await settled;
  });
});

describe('withTimeout on a page that freezes', () => {
  beforeEach(() => {
    // The manual timers move time themselves and settle on the real event loop.
    vi.useRealTimers();
  });

  /** Work that settles only when the test says, with what the timed wait has heard so far. */
  function timedWork(budgetMs: number, timers: ReturnType<typeof manualTimers>) {
    let finish: (value: number) => void = () => undefined;
    const work = new Promise<number>(resolve => {
      finish = resolve;
    });
    const heard: string[] = [];
    void withTimeout(work, budgetMs, () => new SlowError('too slow'), timers).then(
      value => heard.push(`value ${String(value)}`),
      (err: unknown) => heard.push(err instanceof SlowError ? 'timeout' : 'other'),
    );
    return { finish, heard };
  }

  it('As a visitor whose phone suspended the tab, the frozen minutes do not count and the work still gets its whole budget', async () => {
    // Given work with a 90 s budget
    const timers = manualTimers();
    const { finish, heard } = timedWork(90_000, timers);

    // When the page is frozen for five minutes, wakes up, and the work answers 80 s later
    timers.freeze(300_000);
    await timers.advance(80_000);
    finish(7);
    await timers.advance(0);

    // Then
    expect(heard).toEqual(['value 7']);
  });

  it('As a visitor whose phone suspended the tab, work that still does not answer fails one budget after the page wakes', async () => {
    // Given
    const timers = manualTimers();
    const { heard } = timedWork(90_000, timers);

    // When
    timers.freeze(300_000);
    await timers.advance(89_999);
    const beforeBudget = [...heard];
    await timers.advance(1);

    // Then
    expect(beforeBudget).toEqual([]);
    expect(heard).toEqual(['timeout']);
  });

  it('As a visitor in a throttled background tab, a timer a second late still times out', async () => {
    // Given
    const timers = manualTimers();
    const { heard } = timedWork(90_000, timers);

    // When the timer fires a second after it was due
    timers.freeze(91_000);
    await timers.advance(0);

    // Then
    expect(heard).toEqual(['timeout']);
  });
});
