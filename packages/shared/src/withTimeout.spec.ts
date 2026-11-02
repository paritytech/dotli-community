// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { createDeferred } from './createDeferred.js';
import { createManualTimers, type ManualTimers } from './testing/createManualTimers.js';
import { withTimeout } from './withTimeout.js';

class SlowError extends Error {}

/** Work that never settles, so only the timeout or the abort ends the wait. */
function neverSettles(): Promise<never> {
  return new Promise<never>(() => undefined);
}

describe('withTimeout', () => {
  it('As a caller whose work never settles, I wait out the time and get the error I named', async () => {
    // When, on the page's own timers
    const timed = withTimeout({ work: neverSettles(), ms: 1, timeoutError: () => new SlowError('too slow') });

    // Then
    await expect(timed).rejects.toBeInstanceOf(SlowError);
  });

  it("As a caller whose work settles in time, I get the work's value and leave no timer running", async () => {
    // Given
    const timers = createManualTimers();

    // When
    const value = await withTimeout({
      work: Promise.resolve(7),
      ms: 1_000,
      timeoutError: () => new SlowError('too slow'),
      timers,
    });

    // Then
    expect(value).toBe(7);
    expect(timers.countPending()).toBe(0);
  });

  it("As a caller whose work fails first, I get the work's error and leave no timer running", async () => {
    // Given
    const timers = createManualTimers();
    const failure = new Error('read failed');

    // When
    const timed = withTimeout({
      work: Promise.reject(failure),
      ms: 1_000,
      timeoutError: () => new SlowError('too slow'),
      timers,
    });

    // Then
    await expect(timed).rejects.toBe(failure);
    expect(timers.countPending()).toBe(0);
  });

  it('As a caller whose error factory throws a string, I time out and get an Error that keeps the string as its cause', async () => {
    // Given
    const timers = createManualTimers();
    const timed = withTimeout({
      work: neverSettles(),
      ms: 1_000,
      timeoutError: () => {
        // eslint-disable-next-line no-throw-literal, @typescript-eslint/only-throw-error -- the case under test is a non-Error throw
        throw 'plain string';
      },
      timers,
    });
    const settled = expect(timed).rejects.toMatchObject({ cause: 'plain string' });

    // When
    await timers.advance(1_000);

    // Then
    await settled;
    await expect(timed).rejects.toBeInstanceOf(Error);
  });

  it('As a caller sharing work with another, I wait on the tighter budget and fail while the other still gets the value', async () => {
    // Given
    const timers = createManualTimers();
    let resolve: (value: number) => void = () => undefined;
    const work = new Promise<number>(done => {
      resolve = done;
    });
    const tight = withTimeout({ work, ms: 1_000, timeoutError: () => new SlowError('tight'), timers });
    const loose = withTimeout({ work, ms: 5_000, timeoutError: () => new SlowError('loose'), timers });
    const tightSettled = expect(tight).rejects.toBeInstanceOf(SlowError);

    // When
    await timers.advance(1_000);
    resolve(3);

    // Then
    await tightSettled;
    await expect(loose).resolves.toBe(3);
  });

  it('As a caller whose timeout error cannot be made, I wait out the time and get what stopped it', async () => {
    // Given
    const timers = createManualTimers();
    const broken = new TypeError('the abort could not be posted');
    const timed = withTimeout({
      work: neverSettles(),
      ms: 1_000,
      timeoutError: () => {
        throw broken;
      },
      timers,
    });
    const settled = expect(timed).rejects.toBe(broken);

    // When
    await timers.advance(1_000);

    // Then
    await settled;
  });
});

describe('withTimeout on a page that freezes', () => {
  /** Work that settles only when the test says, with what the timed wait has heard so far. */
  function timedWork(budgetMs: number, timers: ManualTimers) {
    let finish: (value: number) => void = () => undefined;
    const work = new Promise<number>(resolve => {
      finish = resolve;
    });
    const heard: string[] = [];
    void withTimeout({ work, ms: budgetMs, timeoutError: () => new SlowError('too slow'), timers }).then(
      value => heard.push(`value ${String(value)}`),
      (error: unknown) => heard.push(error instanceof SlowError ? 'timeout' : 'other'),
    );
    return { finish, heard };
  }

  it('As a visitor whose phone suspended the tab, I wait on work and the frozen minutes do not count against its budget', async () => {
    // Given work with a 90 s budget
    const timers = createManualTimers();
    const { finish, heard } = timedWork(90_000, timers);

    // When the page is frozen for five minutes, wakes up, and the work answers 80 s later
    timers.freeze(300_000);
    await timers.advance(80_000);
    finish(7);
    await timers.advance(0);

    // Then
    expect(heard).toEqual(['value 7']);
  });

  it('As a visitor whose phone suspended the tab, I wait on work that never answers and it fails one budget after the page wakes', async () => {
    // Given
    const timers = createManualTimers();
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

  it('As a visitor in a throttled background tab, I wait on work and a timer a second late still times out', async () => {
    // Given
    const timers = createManualTimers();
    const { heard } = timedWork(90_000, timers);

    // When the timer fires a second after it was due
    timers.freeze(91_000);
    await timers.advance(0);

    // Then
    expect(heard).toEqual(['timeout']);
  });
});

describe('withTimeout with a signal', () => {
  it('As a caller that aborts, I stop waiting on withTimeout and its timer is cleared', async () => {
    // Given
    const timers = createManualTimers();
    const controller = new AbortController();
    const timed = withTimeout({
      work: neverSettles(),
      ms: 1_000,
      timeoutError: () => new SlowError('too slow'),
      timers,
      signal: controller.signal,
    });

    // When
    controller.abort('the visitor left');

    // Then
    await expect(timed).rejects.toBe('the visitor left');
    expect(timers.countPending()).toBe(0);
  });

  it('As a caller with an aborted signal, I call withTimeout and it rejects at once', async () => {
    // Given
    const timers = createManualTimers();
    const controller = new AbortController();
    controller.abort('the visitor left');

    // When
    const timed = withTimeout({
      work: neverSettles(),
      ms: 1_000,
      timeoutError: () => new SlowError('too slow'),
      timers,
      signal: controller.signal,
    });

    // Then
    await expect(timed).rejects.toBe('the visitor left');
    expect(timers.countPending()).toBe(0);
  });

  it('As a caller with an aborted signal, I call withTimeout on work that rejects later and nothing goes unhandled', async () => {
    // Given
    const controller = new AbortController();
    controller.abort('the visitor left');
    const { promise: work, reject } = createDeferred<number>();
    const then = vi.spyOn(work, 'then');

    // When
    const timed = withTimeout({
      work,
      ms: 1_000,
      timeoutError: () => new SlowError('too slow'),
      timers: createManualTimers(),
      signal: controller.signal,
    });
    reject(new Error('the work failed late'));

    // Then
    await expect(timed).rejects.toBe('the visitor left');
    expect(then.mock.calls.some(([, onRejected]) => typeof onRejected === 'function')).toBe(true);
  });

  it('As a caller whose work settles, I call withTimeout and leave no abort listener on my signal', async () => {
    // Given
    const { signal } = new AbortController();
    const added = vi.spyOn(signal, 'addEventListener');
    const removed = vi.spyOn(signal, 'removeEventListener');

    // When
    await withTimeout({
      work: Promise.resolve(7),
      ms: 1_000,
      timeoutError: () => new SlowError('too slow'),
      timers: createManualTimers(),
      signal,
    });

    // Then
    expect(added).toHaveBeenCalledTimes(1);
    expect(removed.mock.calls).toEqual(added.mock.calls.map(([type, listener]) => [type, listener]));
  });
});
