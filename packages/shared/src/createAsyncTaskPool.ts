// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Ported from polkadot-desktop's `createAsyncTaskPool`. One place for queueing, bounded concurrency, retries and
// abort, so modules do not grow their own in-flight flags and retry timers.

import { realTimers, type Timers } from './realTimers.js';

type Params = {
  /**
   * How many tasks of one pool run at once. Aborted work that runs on counts only when the pool holds slots on
   * abort.
   */
  poolSize: number;
  /** Extra attempts after a failure. */
  retryCount?: number;
  /** The wait before a retry, fixed or from the retry's index, which starts at 0, and the failure it follows. */
  retryDelay?: number | ((retry: number, error: unknown) => number);
  /**
   * Whether a failure is worth another attempt. Asked only while retries remain, and without it every failure
   * retries.
   */
  retryIf?: (error: unknown) => boolean;
  /**
   * Whether an aborted task keeps its slot until its work settles, so the pool's works never overlap. By default an
   * abort frees the slot at once while the work may still run. Aborted work that never settles keeps its slot for good.
   */
  holdSlotOnAbort?: boolean;
  /** The timers delays and retry waits run on. The page's own by default. */
  timers?: Pick<Timers, 'setTimeout' | 'clearTimeout'>;
};

type TaskParams = {
  /** Tasks share capacity only with tasks of the same pool. */
  pool?: string;
  /**
   * Aborting rejects the task with the signal's reason at once. Its slot frees at once, or once its work settles when
   * the pool holds slots on abort.
   */
  signal?: AbortSignal;
  /** The wait before the task is queued. `settle` counts it as pending meanwhile. */
  delay?: number;
};

// `delayed` covers both the initial delay and a retry wait. `abandoned` is aborted while running under the hold.
type TaskPhase =
  | { kind: 'delayed'; timer: unknown }
  | { kind: 'queued' }
  | { kind: 'running' }
  | { kind: 'abandoned' }
  | { kind: 'done' };

type Task = {
  readonly work: () => unknown;
  readonly pool: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
  readonly signal: AbortSignal | undefined;
  retry: number;
  phase: TaskPhase;
  onAbort: (() => void) | undefined;
};

export type AsyncTaskPool = ReturnType<typeof createAsyncTaskPool>;

const DEFAULT_POOL = 'default';

/**
 * Runs tasks in named pools of bounded size, with retries and abort.
 *
 * @example
 * const steps = createAsyncTaskPool({ poolSize: 1 });
 * await steps.call(() => refresh()); // a call made meanwhile waits its turn
 */
export function createAsyncTaskPool({
  poolSize,
  retryCount = 0,
  retryDelay = 0,
  retryIf,
  holdSlotOnAbort = false,
  timers = realTimers,
}: Params) {
  // Every task not yet done, in queue order.
  const tasks = new Set<Task>();
  const settleWaiters = new Map<string, (() => void)[]>();

  return {
    /**
     * Runs `work` in its pool and settles with what it returns. Rejects with the signal's reason when the signal
     * aborts first, with the last failure once no retry is left, and with an `AggregateError` of both throws when
     * `retryIf` or `retryDelay` throws.
     */
    call<T>(work: () => T | PromiseLike<T>, { pool = DEFAULT_POOL, signal, delay = 0 }: TaskParams = {}): Promise<T> {
      if (signal?.aborted === true) {
        // The reason passes through as it is. The cast only meets the rule that rejections are errors.
        return Promise.reject(signal.reason as Error);
      }
      return new Promise<T>((resolve, reject) => {
        const task: Task = {
          work,
          pool,
          resolve: value => {
            // The value is what `work` returned, so it has the call's type.
            resolve(value as T);
          },
          reject,
          signal,
          retry: 0,
          phase:
            delay > 0
              ? delayedPhase(delay, () => {
                  enqueue(task);
                })
              : { kind: 'queued' },
          onAbort: undefined,
        };
        if (signal !== undefined) {
          task.onAbort = () => {
            abort(task);
          };
          signal.addEventListener('abort', task.onAbort, { once: true });
        }
        if (delay > 0) {
          tasks.add(task);
          return;
        }
        enqueue(task);
      });
    },
    /**
     * Resolves once the pool has nothing queued, running, delayed or waiting to retry, nor aborted work it holds a
     * slot for.
     */
    settle(pool: string = DEFAULT_POOL): Promise<void> {
      if (isIdle(pool)) {
        return Promise.resolve();
      }
      return new Promise<void>(resolve => {
        const waiters = settleWaiters.get(pool) ?? [];
        waiters.push(resolve);
        settleWaiters.set(pool, waiters);
      });
    },
  };

  /** Starts queued tasks of the pool while it has room, then tells `settle` waiters if nothing is left. */
  function pump(pool: string): void {
    while (hasRoom(pool)) {
      const task = findNext(pool);
      if (task === undefined) {
        break;
      }
      task.phase = { kind: 'running' };
      void run(task);
    }
    const waiters = settleWaiters.get(pool);
    if (waiters !== undefined && isIdle(pool)) {
      settleWaiters.delete(pool);
      for (const resolve of waiters) {
        resolve();
      }
    }
  }

  // Never rejects: the outcome goes to the caller through the task's own promise.
  async function run(task: Task): Promise<void> {
    let result: PromiseSettledResult<unknown>;
    try {
      result = { status: 'fulfilled', value: await task.work() };
    } catch (reason) {
      result = { status: 'rejected', reason };
    }
    handleWorkSettled(task, result);
  }

  /** Acts on the outcome of a task's work by the phase the task reached while the work ran. */
  function handleWorkSettled(task: Task, result: PromiseSettledResult<unknown>): void {
    switch (task.phase.kind) {
      case 'running':
        finishRun(task, result);
        return;
      case 'abandoned':
        markDone(task);
        pump(task.pool);
        return;
      case 'delayed':
      case 'queued':
      case 'done':
        // An abort ended the task and rejected its call. A delayed or queued task has no work in flight.
        return;
    }
  }

  function finishRun(task: Task, result: PromiseSettledResult<unknown>): void {
    switch (result.status) {
      case 'fulfilled':
        markDone(task);
        task.resolve(result.value);
        pump(task.pool);
        return;
      case 'rejected':
        failRun(task, result.reason);
        return;
    }
  }

  /** Retries the failed task after its wait while retries remain, or rejects its call. */
  function failRun(task: Task, error: unknown): void {
    let delay: number | undefined;
    try {
      const retry = task.retry < retryCount && (retryIf?.(error) ?? true);
      delay = retry ? getRetryDelay(task.retry, error) : undefined;
    } catch (callbackError) {
      // A throwing retryIf or retryDelay must still settle the call, and the task's own failure stays visible.
      markDone(task);
      task.reject(new AggregateError([callbackError, error], 'Could not decide whether to retry the task'));
      pump(task.pool);
      return;
    }
    if (delay === undefined) {
      markDone(task);
      task.reject(error);
      pump(task.pool);
      return;
    }
    task.retry += 1;
    queueAfter(task, delay);
    pump(task.pool);
  }

  /** Queues the task once `ms` has passed. Until then it is delayed, so `settle` holds and an abort clears it. */
  function queueAfter(task: Task, ms: number): void {
    task.phase = delayedPhase(ms, () => {
      enqueue(task);
    });
    tasks.add(task);
  }

  function delayedPhase(ms: number, onElapsed: () => void): TaskPhase {
    return { kind: 'delayed', timer: timers.setTimeout(onElapsed, ms) };
  }

  /** Puts the task at the end of the queue, behind those queued while it waited, and starts what has room. */
  function enqueue(task: Task): void {
    tasks.delete(task);
    tasks.add(task);
    task.phase = { kind: 'queued' };
    pump(task.pool);
  }

  function abort(task: Task): void {
    applyAbort(task);
    task.reject(task.signal?.reason);
    pump(task.pool);
  }

  /** Ends an aborted task, or abandons it while its work runs on when the pool holds slots on abort. */
  function applyAbort(task: Task): void {
    switch (task.phase.kind) {
      case 'delayed':
        timers.clearTimeout(task.phase.timer);
        markDone(task);
        return;
      case 'queued':
        markDone(task);
        return;
      case 'running':
        if (holdSlotOnAbort) {
          task.phase = { kind: 'abandoned' };
          return;
        }
        markDone(task);
        return;
      case 'abandoned':
      case 'done':
        // Its call has already settled, so it keeps its phase.
        return;
    }
  }

  function markDone(task: Task): void {
    task.phase = { kind: 'done' };
    tasks.delete(task);
    if (task.onAbort !== undefined) {
      task.signal?.removeEventListener('abort', task.onAbort);
    }
  }

  /** The first queued task of the pool whose signal has not aborted. */
  function findNext(pool: string): Task | undefined {
    for (const task of tasks) {
      // A task whose signal is already aborted is left for its own abort listener, which may not have run yet when
      // another task on the same signal frees a slot.
      if (task.pool === pool && task.phase.kind === 'queued' && task.signal?.aborted !== true) {
        return task;
      }
    }
    return undefined;
  }

  function hasRoom(pool: string): boolean {
    if (poolSize === Number.POSITIVE_INFINITY) {
      return true;
    }
    let count = 0;
    for (const task of tasks) {
      if (task.pool === pool && hasSlot(task.phase)) {
        count += 1;
        if (count >= poolSize) {
          return false;
        }
      }
    }
    return count < poolSize;
  }

  function isIdle(pool: string): boolean {
    for (const task of tasks) {
      if (task.pool === pool) {
        return false;
      }
    }
    return true;
  }

  function getRetryDelay(retry: number, error: unknown): number {
    return typeof retryDelay === 'function' ? retryDelay(retry, error) : retryDelay;
  }
}

function hasSlot(phase: TaskPhase): boolean {
  switch (phase.kind) {
    case 'running':
    case 'abandoned':
      return true;
    case 'delayed':
    case 'queued':
    case 'done':
      return false;
  }
}
