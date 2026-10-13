// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAsyncTaskPool } from './async-task-pool.js';

// Fake timers, so a "wait" is a step the test advances, never a real sleep.
const wait = (ms: number): Promise<void> =>
  new Promise(resolve => {
    setTimeout(resolve, ms);
  });

/** Settles with the error a call rejects with, read when the test is ready, so no rejection goes unhandled. */
const rejection = (call: Promise<unknown>): Promise<unknown> =>
  call.then(
    value => {
      throw new Error(`expected a rejection, got ${String(value)}`);
    },
    (error: unknown) => error,
  );

describe('async task pool', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('As a caller, I get back what my task returns, sync or async', async () => {
    // Given
    const pool = createAsyncTaskPool({ poolSize: 1 });

    // When
    const sync = pool.call(() => 'sync');
    const async = pool.call(() => wait(10).then(() => 'async'));
    await vi.advanceTimersByTimeAsync(10);

    // Then
    await expect(sync).resolves.toBe('sync');
    await expect(async).resolves.toBe('async');
  });

  it('As a caller, my task failing, by a throw or a rejection, rejects my call with its error', async () => {
    // Given
    const pool = createAsyncTaskPool({ poolSize: 1 });
    const thrown = new Error('thrown');
    const rejected = new Error('rejected');

    // When
    const fromThrow = pool.call(() => {
      throw thrown;
    });
    const fromRejection = pool.call(() => Promise.reject(rejected));

    // Then
    await expect(fromThrow).rejects.toBe(thrown);
    await expect(fromRejection).rejects.toBe(rejected);
  });

  it('As a caller, no more of my tasks run at once than the pool size, and each finishes in its own time', async () => {
    // Given
    const pool = createAsyncTaskPool({ poolSize: 2 });
    const finished: number[] = [];
    let running = 0;
    let mostAtOnce = 0;
    const task = (value: number, ms: number) => async (): Promise<void> => {
      running += 1;
      mostAtOnce = Math.max(mostAtOnce, running);
      await wait(ms);
      running -= 1;
      finished.push(value);
    };

    // When
    const all = Promise.all([
      pool.call(task(1, 800)),
      pool.call(task(2, 100)),
      pool.call(task(3, 500)),
      pool.call(task(4, 100)),
    ]);
    await vi.advanceTimersByTimeAsync(800);
    await all;

    // Then
    expect(mostAtOnce).toBe(2);
    expect(finished).toEqual([2, 3, 4, 1]);
  });

  it('As a caller, a failing task is retried up to the retry count, then rejects', async () => {
    // Given
    const pool = createAsyncTaskPool({ poolSize: 1, retryCount: 2 });
    const flaky = vi.fn().mockRejectedValueOnce(new Error('once')).mockResolvedValueOnce('done');
    const broken = vi.fn().mockRejectedValue(new Error('always'));

    // When
    const recovered = pool.call(flaky);
    const failed = rejection(pool.call(broken));
    await vi.runAllTimersAsync();

    // Then
    await expect(recovered).resolves.toBe('done');
    expect(flaky).toHaveBeenCalledTimes(2);
    expect(await failed).toEqual(new Error('always'));
    expect(broken).toHaveBeenCalledTimes(3);
  });

  it('As a caller, the retry delay is asked with the index of each retry and the failure it follows', async () => {
    // Given
    const failure = new Error('boom');
    const retryDelay = vi.fn((retry: number) => retry * 100);
    const pool = createAsyncTaskPool({ poolSize: 1, retryCount: 2, retryDelay });

    // When
    const call = pool.call(() => Promise.reject(failure));
    const outcome = call.catch((error: unknown) => error);
    await vi.runAllTimersAsync();

    // Then
    await expect(outcome).resolves.toBe(failure);
    expect(retryDelay.mock.calls).toEqual([
      [0, failure],
      [1, failure],
    ]);
  });

  it('As a caller, my retry waits as long as the failure asks', async () => {
    // Given a task that fails once with a failure that names its own wait
    const busy = Object.assign(new Error('busy'), { waitMs: 700 });
    let runs = 0;
    const pool = createAsyncTaskPool({
      poolSize: 1,
      retryCount: 1,
      retryDelay: (_retry, error) => (error as { waitMs: number }).waitMs,
    });

    // When
    const call = pool.call(() => {
      runs += 1;
      if (runs === 1) {
        throw busy;
      }
      return 'done';
    });
    await vi.advanceTimersByTimeAsync(699);
    const runsBeforeTheWait = runs;
    await vi.advanceTimersByTimeAsync(1);

    // Then
    expect(runsBeforeTheWait).toBe(1);
    await expect(call).resolves.toBe('done');
    expect(runs).toBe(2);
  });

  it('As a caller, pools are independent, each with its own capacity', async () => {
    // Given
    const pool = createAsyncTaskPool({ poolSize: 1 });
    const finished: number[] = [];
    const task = (value: number, ms: number) => (): Promise<void> => wait(ms).then(() => void finished.push(value));

    // When
    const all = Promise.all([
      pool.call(task(1, 600), { pool: 'a' }),
      pool.call(task(2, 400), { pool: 'b' }),
      pool.call(task(3, 100), { pool: 'a' }),
      pool.call(task(4, 0), { pool: 'b' }),
    ]);
    await vi.advanceTimersByTimeAsync(700);
    await all;

    // Then
    expect(finished).toEqual([2, 4, 1, 3]);
  });

  it('As a caller, settle waits for every task of the pool, those queued by finishing tasks included', async () => {
    // Given
    const pool = createAsyncTaskPool({ poolSize: 1 });
    const finished: number[] = [];
    for (const value of [1, 2, 3, 4]) {
      void pool
        .call(() => wait(10), { pool: 'chain' })
        .then(() => {
          finished.push(value);
          void pool.call(() => wait(10).then(() => void finished.push(value + 10)), { pool: 'chain' });
        });
    }

    // When
    const settled = pool.settle('chain');
    await vi.runAllTimersAsync();
    await settled;

    // Then
    expect(finished).toEqual([1, 2, 3, 4, 11, 12, 13, 14]);
  });

  it('As a caller, settling an idle pool resolves at once, whatever other pools are doing', async () => {
    // Given
    const pool = createAsyncTaskPool({ poolSize: 1 });
    void pool.call(() => wait(1_000), { pool: 'busy' });

    // When
    const settled = pool.settle('idle');

    // Then
    await expect(settled).resolves.toBeUndefined();
  });

  it('As a caller, settle waits for a task that is waiting to retry', async () => {
    // Given
    const pool = createAsyncTaskPool({ poolSize: 1, retryCount: 1, retryDelay: 100 });
    const task = vi.fn().mockRejectedValueOnce(new Error('once')).mockResolvedValueOnce('done');
    const call = pool.call(task);
    let settled = false;

    // When
    void pool.settle().then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(50);
    const settledDuringDelay = settled;
    await vi.advanceTimersByTimeAsync(50);

    // Then
    expect(settledDuringDelay).toBe(false);
    await expect(call).resolves.toBe('done');
    expect(settled).toBe(true);
  });

  it('As a caller, a call with a signal that is already aborted rejects without running', async () => {
    // Given
    const pool = createAsyncTaskPool({ poolSize: 1 });
    const task = vi.fn();
    const controller = new AbortController();
    controller.abort(new Error('aborted'));

    // When
    const call = pool.call(task, { signal: controller.signal });

    // Then
    await expect(call).rejects.toThrow('aborted');
    expect(task).not.toHaveBeenCalled();
  });

  it('As a caller, aborting a queued task rejects it and lets the next one run', async () => {
    // Given
    const pool = createAsyncTaskPool({ poolSize: 1 });
    const controller = new AbortController();
    const queuedTask = vi.fn();
    const blocker = pool.call(() => wait(200));
    const queued = rejection(pool.call(queuedTask, { signal: controller.signal }));
    const next = pool.call(() => 'next');

    // When
    controller.abort(new Error('cancelled'));
    await vi.advanceTimersByTimeAsync(200);

    // Then
    expect(await queued).toEqual(new Error('cancelled'));
    expect(queuedTask).not.toHaveBeenCalled();
    await expect(blocker).resolves.toBeUndefined();
    await expect(next).resolves.toBe('next');
  });

  it('As a caller, aborting a running task rejects it at once and frees its slot', async () => {
    // Given
    const pool = createAsyncTaskPool({ poolSize: 1 });
    const controller = new AbortController();
    const order: string[] = [];
    const running = pool
      .call(() => wait(500).then(() => void order.push('running-done')), { signal: controller.signal })
      .catch((error: unknown) => void order.push(`running-rejected:${(error as Error).message}`));
    const next = pool.call(() => void order.push('next-ran'));
    await vi.advanceTimersByTimeAsync(50);

    // When
    controller.abort(new Error('stop'));
    await running;
    await next;

    // Then
    expect(order).toEqual(['next-ran', 'running-rejected:stop']);
  });

  it('As a caller, aborting one signal shared by a running and a queued task rejects both and never starts the queued one', async () => {
    // Given
    const pool = createAsyncTaskPool({ poolSize: 1 });
    const controller = new AbortController();
    const queuedTask = vi.fn();
    const running = rejection(pool.call(() => wait(500), { signal: controller.signal }));
    const queued = rejection(pool.call(queuedTask, { signal: controller.signal }));
    await vi.advanceTimersByTimeAsync(50);

    // When
    controller.abort(new Error('stop'));
    await vi.advanceTimersByTimeAsync(500);

    // Then
    expect(await running).toEqual(new Error('stop'));
    expect(await queued).toEqual(new Error('stop'));
    expect(queuedTask).not.toHaveBeenCalled();
    await pool.settle();
  });

  it('As a caller, aborting during a retry delay cancels the retry', async () => {
    // Given
    const pool = createAsyncTaskPool({ poolSize: 1, retryCount: 3, retryDelay: 200 });
    const controller = new AbortController();
    const task = vi.fn(() => {
      throw new Error('boom');
    });
    const call = rejection(pool.call(task, { signal: controller.signal }));
    await vi.advanceTimersByTimeAsync(20);

    // When
    controller.abort(new Error('cancelled'));
    await vi.advanceTimersByTimeAsync(1_000);

    // Then
    expect(await call).toEqual(new Error('cancelled'));
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('As a caller, a delayed task runs no earlier than its delay', async () => {
    // Given
    const pool = createAsyncTaskPool({ poolSize: 1 });
    const task = vi.fn(() => 'done');

    // When
    const call = pool.call(task, { delay: 200 });
    await vi.advanceTimersByTimeAsync(199);
    const callsBeforeDelay = task.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1);

    // Then
    expect(callsBeforeDelay).toBe(0);
    await expect(call).resolves.toBe('done');
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('As a caller, settle waits for a task that is waiting out its delay', async () => {
    // Given
    const pool = createAsyncTaskPool({ poolSize: 1 });
    const call = pool.call(() => 'done', { delay: 100 });
    let settled = false;

    // When
    void pool.settle().then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(50);
    const settledDuringDelay = settled;
    await vi.advanceTimersByTimeAsync(50);

    // Then
    expect(settledDuringDelay).toBe(false);
    await expect(call).resolves.toBe('done');
    expect(settled).toBe(true);
  });

  it('As a caller, aborting during a delay rejects the task and it never runs', async () => {
    // Given
    const pool = createAsyncTaskPool({ poolSize: 1 });
    const controller = new AbortController();
    const task = vi.fn();
    const call = rejection(pool.call(task, { delay: 200, signal: controller.signal }));
    await vi.advanceTimersByTimeAsync(20);

    // When
    controller.abort(new Error('cancelled'));
    await vi.advanceTimersByTimeAsync(1_000);

    // Then
    expect(await call).toEqual(new Error('cancelled'));
    expect(task).not.toHaveBeenCalled();
    await expect(pool.settle()).resolves.toBeUndefined();
  });

  it('As a caller, a failure my retryIf rejects is not retried and rejects my call at once', async () => {
    // Given
    const pool = createAsyncTaskPool({ poolSize: 1, retryCount: 3, retryIf: () => false });
    let attempts = 0;
    const permanent = new Error('permanent');

    // When
    const call = pool.call(() => {
      attempts += 1;
      throw permanent;
    });

    // Then
    await expect(call).rejects.toBe(permanent);
    expect(attempts).toBe(1);
  });

  it('As a caller, retryIf sees each failure and stops the retries at the first one it rejects', async () => {
    // Given
    const transient = new Error('transient');
    const permanent = new Error('permanent');
    const seen: unknown[] = [];
    const pool = createAsyncTaskPool({
      poolSize: 1,
      retryCount: 5,
      retryIf: error => {
        seen.push(error);
        return error === transient;
      },
    });
    const failures = [transient, transient, permanent];

    // When
    const call = rejection(
      pool.call(() => {
        throw failures.shift() ?? new Error('ran too often');
      }),
    );
    await vi.runAllTimersAsync();

    // Then
    expect(await call).toBe(permanent);
    expect(seen).toEqual([transient, transient, permanent]);
  });

  it('As a caller, a retryIf that throws rejects my call with both errors instead of leaving it pending', async () => {
    // Given
    const broken = new Error('retryIf broke');
    const failure = new Error('task failed');
    const pool = createAsyncTaskPool({
      poolSize: 1,
      retryCount: 1,
      retryIf: () => {
        throw broken;
      },
    });

    // When
    const call = pool.call(() => {
      throw failure;
    });

    // Then
    await expect(call).rejects.toMatchObject({ errors: [broken, failure] });
    await pool.settle();
  });

  it('As a caller, a retryDelay that throws rejects my call with both errors instead of leaving it pending', async () => {
    // Given
    const broken = new Error('retryDelay broke');
    const failure = new Error('task failed');
    const pool = createAsyncTaskPool({
      poolSize: 1,
      retryCount: 1,
      retryDelay: () => {
        throw broken;
      },
    });

    // When
    const call = pool.call(() => {
      throw failure;
    });

    // Then
    await expect(call).rejects.toMatchObject({ errors: [broken, failure] });
    await pool.settle();
  });
});
