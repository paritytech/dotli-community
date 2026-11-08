// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { createAsyncTaskPool } from './createAsyncTaskPool.js';
import { createManualTimers, type ManualTimers } from './testing/createManualTimers.js';

/** A wait on the given timers, so it is a step the test advances, never a real sleep. */
function wait(timers: ManualTimers, ms: number): Promise<void> {
  return new Promise(resolve => {
    timers.setTimeout(resolve, ms);
  });
}

/** Settles with the error a call rejects with, read when the test is ready, so no rejection goes unhandled. */
function rejection(call: Promise<unknown>): Promise<unknown> {
  return call.then(
    value => {
      throw new Error(`expected a rejection, got ${String(value)}`);
    },
    (error: unknown) => error,
  );
}

describe('async task pool', () => {
  it('As a caller, I get back what my task returns, sync or async', async () => {
    // Given
    const timers = createManualTimers();
    const pool = createAsyncTaskPool({ poolSize: 1, timers });

    // When
    const sync = pool.call(() => 'sync');
    const async = pool.call(() => wait(timers, 10).then(() => 'async'));
    await timers.advance(10);

    // Then
    await expect(sync).resolves.toBe('sync');
    await expect(async).resolves.toBe('async');
  });

  it('As a caller, I run a task that throws or rejects and my call rejects with its error', async () => {
    // Given
    const timers = createManualTimers();
    const pool = createAsyncTaskPool({ poolSize: 1, timers });
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

  it('As a caller, I queue more tasks than the pool size and no more run at once, each finishing in its own time', async () => {
    // Given
    const timers = createManualTimers();
    const pool = createAsyncTaskPool({ poolSize: 2, timers });
    const finished: number[] = [];
    let running = 0;
    let mostAtOnce = 0;
    const task = (value: number, ms: number) => async (): Promise<void> => {
      running += 1;
      mostAtOnce = Math.max(mostAtOnce, running);
      await wait(timers, ms);
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
    await timers.advance(800);
    await all;

    // Then
    expect(mostAtOnce).toBe(2);
    expect(finished).toEqual([2, 3, 4, 1]);
  });

  it('As a caller, I run a failing task and it is retried up to the retry count, then rejects', async () => {
    // Given
    const timers = createManualTimers();
    const pool = createAsyncTaskPool({ poolSize: 1, retryCount: 2, timers });
    const flaky = vi.fn().mockRejectedValueOnce(new Error('once')).mockResolvedValueOnce('done');
    const broken = vi.fn().mockRejectedValue(new Error('always'));

    // When
    const recovered = pool.call(flaky);
    const failed = rejection(pool.call(broken));
    await timers.advance(0);
    await Promise.all([recovered, failed]);

    // Then
    await expect(recovered).resolves.toBe('done');
    expect(flaky).toHaveBeenCalledTimes(2);
    expect(await failed).toEqual(new Error('always'));
    expect(broken).toHaveBeenCalledTimes(3);
  });

  it('As a caller, I give a retry delay and it is asked with the index of each retry and the failure it follows', async () => {
    // Given
    const timers = createManualTimers();
    const failure = new Error('boom');
    const retryDelay = vi.fn((retry: number) => retry * 100);
    const pool = createAsyncTaskPool({ poolSize: 1, retryCount: 2, retryDelay, timers });

    // When
    const call = pool.call(() => Promise.reject(failure));
    const outcome = call.catch((error: unknown) => error);
    await timers.advance(100);
    await outcome;

    // Then
    await expect(outcome).resolves.toBe(failure);
    expect(retryDelay.mock.calls).toEqual([
      [0, failure],
      [1, failure],
    ]);
  });

  it('As a caller, I retry a failure that names its own wait and the retry waits that long', async () => {
    // Given a task that fails once with a failure that names its own wait
    const timers = createManualTimers();
    const busy = Object.assign(new Error('busy'), { waitMs: 700 });
    let runs = 0;
    const pool = createAsyncTaskPool({
      poolSize: 1,
      retryCount: 1,
      retryDelay: (_retry, error) => (error as { waitMs: number }).waitMs,
      timers,
    });

    // When
    const call = pool.call(() => {
      runs += 1;
      if (runs === 1) {
        throw busy;
      }
      return 'done';
    });
    await timers.advance(699);
    const runsBeforeTheWait = runs;
    await timers.advance(1);

    // Then
    expect(runsBeforeTheWait).toBe(1);
    await expect(call).resolves.toBe('done');
    expect(runs).toBe(2);
  });

  it('As a caller, I run tasks in two pools and each pool has its own capacity', async () => {
    // Given
    const timers = createManualTimers();
    const pool = createAsyncTaskPool({ poolSize: 1, timers });
    const finished: number[] = [];
    const task = (value: number, ms: number) => (): Promise<void> =>
      wait(timers, ms).then(() => void finished.push(value));

    // When
    const all = Promise.all([
      pool.call(task(1, 600), { pool: 'a' }),
      pool.call(task(2, 400), { pool: 'b' }),
      pool.call(task(3, 100), { pool: 'a' }),
      pool.call(task(4, 0), { pool: 'b' }),
    ]);
    await timers.advance(700);
    await all;

    // Then
    expect(finished).toEqual([2, 4, 1, 3]);
  });

  it('As a caller, I settle a pool and it waits for every task, those queued by finishing tasks included', async () => {
    // Given
    const timers = createManualTimers();
    const pool = createAsyncTaskPool({ poolSize: 1, timers });
    const finished: number[] = [];
    for (const value of [1, 2, 3, 4]) {
      void pool
        .call(() => wait(timers, 10), { pool: 'chain' })
        .then(() => {
          finished.push(value);
          void pool.call(() => wait(timers, 10).then(() => void finished.push(value + 10)), { pool: 'chain' });
        });
    }

    // When
    const settled = pool.settle('chain');
    // Eight waits of 10 ms, one after another.
    await timers.advance(80);
    await settled;

    // Then
    expect(finished).toEqual([1, 2, 3, 4, 11, 12, 13, 14]);
  });

  it('As a caller, I settle an idle pool and it resolves at once, whatever other pools are doing', async () => {
    // Given
    const timers = createManualTimers();
    const pool = createAsyncTaskPool({ poolSize: 1, timers });
    void pool.call(() => wait(timers, 1_000), { pool: 'busy' });

    // When
    const settled = pool.settle('idle');

    // Then
    await expect(settled).resolves.toBeUndefined();
  });

  it('As a caller, I settle a pool and it waits for a task that is waiting to retry', async () => {
    // Given
    const timers = createManualTimers();
    const pool = createAsyncTaskPool({ poolSize: 1, retryCount: 1, retryDelay: 100, timers });
    const task = vi.fn().mockRejectedValueOnce(new Error('once')).mockResolvedValueOnce('done');
    const call = pool.call(task);
    let settled = false;

    // When
    void pool.settle().then(() => {
      settled = true;
    });
    await timers.advance(50);
    const settledDuringDelay = settled;
    await timers.advance(50);

    // Then
    expect(settledDuringDelay).toBe(false);
    await expect(call).resolves.toBe('done');
    expect(settled).toBe(true);
  });

  it('As a caller, I call with a signal that is already aborted and my call rejects without running', async () => {
    // Given
    const timers = createManualTimers();
    const pool = createAsyncTaskPool({ poolSize: 1, timers });
    const task = vi.fn();
    const controller = new AbortController();
    controller.abort(new Error('aborted'));

    // When
    const call = pool.call(task, { signal: controller.signal });

    // Then
    await expect(call).rejects.toThrow('aborted');
    expect(task).not.toHaveBeenCalled();
  });

  it('As a caller, I abort a queued task and it rejects while the next one runs', async () => {
    // Given
    const timers = createManualTimers();
    const pool = createAsyncTaskPool({ poolSize: 1, timers });
    const controller = new AbortController();
    const queuedTask = vi.fn();
    const blocker = pool.call(() => wait(timers, 200));
    const queued = rejection(pool.call(queuedTask, { signal: controller.signal }));
    const next = pool.call(() => 'next');

    // When
    controller.abort(new Error('cancelled'));
    await timers.advance(200);

    // Then
    expect(await queued).toEqual(new Error('cancelled'));
    expect(queuedTask).not.toHaveBeenCalled();
    await expect(blocker).resolves.toBeUndefined();
    await expect(next).resolves.toBe('next');
  });

  it('As a caller, I abort a running task and it rejects at once and frees its slot', async () => {
    // Given
    const timers = createManualTimers();
    const pool = createAsyncTaskPool({ poolSize: 1, timers });
    const controller = new AbortController();
    const order: string[] = [];
    const running = pool
      .call(() => wait(timers, 500).then(() => void order.push('running-done')), { signal: controller.signal })
      .catch((error: unknown) => void order.push(`running-rejected:${(error as Error).message}`));
    const next = pool.call(() => void order.push('next-ran'));
    await timers.advance(50);

    // When
    controller.abort(new Error('stop'));
    await running;
    await next;

    // Then
    expect(order).toEqual(['next-ran', 'running-rejected:stop']);
  });

  it('As a caller, I abort one signal shared by a running and a queued task and both reject, the queued one never started', async () => {
    // Given
    const timers = createManualTimers();
    const pool = createAsyncTaskPool({ poolSize: 1, timers });
    const controller = new AbortController();
    const queuedTask = vi.fn();
    const running = rejection(pool.call(() => wait(timers, 500), { signal: controller.signal }));
    const queued = rejection(pool.call(queuedTask, { signal: controller.signal }));
    await timers.advance(50);

    // When
    controller.abort(new Error('stop'));
    await timers.advance(500);

    // Then
    expect(await running).toEqual(new Error('stop'));
    expect(await queued).toEqual(new Error('stop'));
    expect(queuedTask).not.toHaveBeenCalled();
    await pool.settle();
  });

  it('As a caller of a pool that holds slots on abort, I abort a running task and it rejects at once while the next task waits for the aborted work', async () => {
    // Given
    const timers = createManualTimers();
    const pool = createAsyncTaskPool({ poolSize: 1, holdSlotOnAbort: true, timers });
    const controller = new AbortController();
    const order: string[] = [];
    const running = pool
      .call(() => wait(timers, 500).then(() => void order.push('running-work-done')), { signal: controller.signal })
      .catch((error: unknown) => void order.push(`running-rejected:${(error as Error).message}`));
    const next = pool.call(() => void order.push('next-ran'));
    await timers.advance(50);

    // When
    controller.abort(new Error('stop'));
    await timers.advance(500);
    await running;
    await next;

    // Then
    expect(order).toEqual(['running-rejected:stop', 'running-work-done', 'next-ran']);
  });

  it('As a caller of a pool that holds slots on abort, I settle after an abort and wait for the aborted work', async () => {
    // Given
    const timers = createManualTimers();
    const pool = createAsyncTaskPool({ poolSize: 1, holdSlotOnAbort: true, timers });
    const controller = new AbortController();
    const running = rejection(pool.call(() => wait(timers, 500), { signal: controller.signal }));
    await timers.advance(50);
    controller.abort(new Error('stop'));
    let settled = false;

    // When
    const settling = pool.settle().then(() => {
      settled = true;
    });
    await timers.advance(449);
    const settledEarly = settled;
    await timers.advance(51);
    await settling;

    // Then
    expect(settledEarly).toBe(false);
    expect(settled).toBe(true);
    expect(await running).toEqual(new Error('stop'));
  });

  it('As a caller of a pool that holds slots on abort, I abort a queued task and the next one runs once the running one ends', async () => {
    // Given
    const timers = createManualTimers();
    const pool = createAsyncTaskPool({ poolSize: 1, holdSlotOnAbort: true, timers });
    const controller = new AbortController();
    const order: string[] = [];
    const queuedTask = vi.fn();
    const blocker = pool.call(() => wait(timers, 200).then(() => order.push('blocker ended')));
    const queued = rejection(pool.call(queuedTask, { signal: controller.signal }));
    const third = pool.call(() => order.push('third ran'));

    // When
    controller.abort(new Error('cancelled'));
    await timers.advance(200);
    await Promise.all([blocker, third]);

    // Then
    expect(await queued).toEqual(new Error('cancelled'));
    expect(queuedTask).not.toHaveBeenCalled();
    expect(order).toEqual(['blocker ended', 'third ran']);
  });

  it('As a caller of a pool that holds slots on abort and retries, I abort a running task whose work then fails and the next task waits for it and no retry runs', async () => {
    // Given
    const timers = createManualTimers();
    const pool = createAsyncTaskPool({ poolSize: 1, retryCount: 2, holdSlotOnAbort: true, timers });
    const controller = new AbortController();
    const order: string[] = [];
    const work = vi.fn(() =>
      wait(timers, 500).then(() => {
        throw new Error('failed');
      }),
    );
    const running = rejection(pool.call(work, { signal: controller.signal }));
    const next = pool.call(() => void order.push('next-ran'));
    await timers.advance(50);

    // When
    controller.abort(new Error('stop'));
    await timers.advance(449);
    const ranEarly = order.length > 0;
    await timers.advance(51);
    await next;

    // Then
    expect(ranEarly).toBe(false);
    expect(work).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['next-ran']);
    expect(await running).toEqual(new Error('stop'));
  });

  it('As a caller, I queue tasks behind one that fails and its retry runs after every task queued before the retry', async () => {
    // Given
    const timers = createManualTimers();
    const pool = createAsyncTaskPool({ poolSize: 1, retryCount: 1, timers });
    const order: string[] = [];
    let firstRuns = 0;
    const first = pool.call(() => {
      firstRuns += 1;
      if (firstRuns === 1) {
        order.push('first-failed');
        throw new Error('once');
      }
      order.push('first-retried');
    });
    const second = pool.call(() => {
      order.push('second-ran');
      return wait(timers, 100);
    });
    const third = pool.call(() => void order.push('third-ran'));

    // When
    await timers.advance(200);
    await Promise.all([first, second, third]);

    // Then
    expect(order).toEqual(['first-failed', 'second-ran', 'third-ran', 'first-retried']);
  });

  it('As a caller, I abort during a retry delay and the retry never runs', async () => {
    // Given
    const timers = createManualTimers();
    const pool = createAsyncTaskPool({ poolSize: 1, retryCount: 3, retryDelay: 200, timers });
    const controller = new AbortController();
    const task = vi.fn(() => {
      throw new Error('boom');
    });
    const call = rejection(pool.call(task, { signal: controller.signal }));
    await timers.advance(20);

    // When
    controller.abort(new Error('cancelled'));
    await timers.advance(1_000);

    // Then
    expect(await call).toEqual(new Error('cancelled'));
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('As a caller, I delay a task and it runs no earlier than its delay', async () => {
    // Given
    const timers = createManualTimers();
    const pool = createAsyncTaskPool({ poolSize: 1, timers });
    const task = vi.fn(() => 'done');

    // When
    const call = pool.call(task, { delay: 200 });
    await timers.advance(199);
    const callsBeforeDelay = task.mock.calls.length;
    await timers.advance(1);

    // Then
    expect(callsBeforeDelay).toBe(0);
    await expect(call).resolves.toBe('done');
    expect(task).toHaveBeenCalledTimes(1);
  });

  it.each([Number.NaN, -1])(
    'As a caller, I pass a delay that is not a positive number (%s) and the task runs at once',
    async delay => {
      // Given
      const timers = createManualTimers();
      const pool = createAsyncTaskPool({ poolSize: 1, timers });
      const task = vi.fn(() => 'done');

      // When
      const call = pool.call(task, { delay });

      // Then
      expect(task).toHaveBeenCalledTimes(1);
      await expect(call).resolves.toBe('done');
    },
  );

  it('As a caller, I settle a pool and it waits for a task that is waiting out its delay', async () => {
    // Given
    const timers = createManualTimers();
    const pool = createAsyncTaskPool({ poolSize: 1, timers });
    const call = pool.call(() => 'done', { delay: 100 });
    let settled = false;

    // When
    void pool.settle().then(() => {
      settled = true;
    });
    await timers.advance(50);
    const settledDuringDelay = settled;
    await timers.advance(50);

    // Then
    expect(settledDuringDelay).toBe(false);
    await expect(call).resolves.toBe('done');
    expect(settled).toBe(true);
  });

  it('As a caller, I abort during a delay and the task rejects without ever running', async () => {
    // Given
    const timers = createManualTimers();
    const pool = createAsyncTaskPool({ poolSize: 1, timers });
    const controller = new AbortController();
    const task = vi.fn();
    const call = rejection(pool.call(task, { delay: 200, signal: controller.signal }));
    await timers.advance(20);

    // When
    controller.abort(new Error('cancelled'));
    await timers.advance(1_000);

    // Then
    expect(await call).toEqual(new Error('cancelled'));
    expect(task).not.toHaveBeenCalled();
    await expect(pool.settle()).resolves.toBeUndefined();
  });

  it('As a caller, I turn down a failure in retryIf and my call rejects at once without a retry', async () => {
    // Given
    const timers = createManualTimers();
    const pool = createAsyncTaskPool({ poolSize: 1, retryCount: 3, retryIf: () => false, timers });
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

  it('As a caller, I give a retryIf and it sees each failure, stopping the retries at the first one it turns down', async () => {
    // Given
    const timers = createManualTimers();
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
      timers,
    });
    const failures = [transient, transient, permanent];

    // When
    const call = rejection(
      pool.call(() => {
        throw failures.shift() ?? new Error('ran too often');
      }),
    );
    await timers.advance(0);
    await call;

    // Then
    expect(await call).toBe(permanent);
    expect(seen).toEqual([transient, transient, permanent]);
  });

  it('As a caller, I give a retryIf that throws and my call rejects with both errors instead of staying pending', async () => {
    // Given
    const timers = createManualTimers();
    const broken = new Error('retryIf broke');
    const failure = new Error('task failed');
    const pool = createAsyncTaskPool({
      poolSize: 1,
      retryCount: 1,
      retryIf: () => {
        throw broken;
      },
      timers,
    });

    // When
    const call = pool.call(() => {
      throw failure;
    });

    // Then
    await expect(call).rejects.toMatchObject({ errors: [broken, failure] });
    await pool.settle();
  });

  it('As a caller, I give a retryDelay that throws and my call rejects with both errors instead of staying pending', async () => {
    // Given
    const timers = createManualTimers();
    const broken = new Error('retryDelay broke');
    const failure = new Error('task failed');
    const pool = createAsyncTaskPool({
      poolSize: 1,
      retryCount: 1,
      retryDelay: () => {
        throw broken;
      },
      timers,
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

describe('async task pool on timers it is given', () => {
  it('As a caller, I pass my own timers and my retry waits on them, with the globals left alone', async () => {
    // Given a task that fails once, on a pool that retries after 500 ms
    const timers = createManualTimers();
    let runs = 0;
    const pool = createAsyncTaskPool({ poolSize: 1, retryCount: 1, retryDelay: 500, timers });
    const call = pool.call(() => {
      runs += 1;
      return runs === 1 ? Promise.reject(new Error('busy')) : 'done';
    });

    // When the given timers pass the delay in two steps
    await timers.advance(499);
    const beforeTheDelay = runs;
    await timers.advance(1);

    // Then the retry ran only once the full delay passed
    expect(beforeTheDelay).toBe(1);
    expect(runs).toBe(2);
    await expect(call).resolves.toBe('done');
  });
});
