// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Ported from polkadot-desktop's `createAsyncTaskPool`. One place for queueing, bounded concurrency, retries and
// abort, so modules do not grow their own in-flight flags and retry timers.

import { realTimers, type Timers } from './realTimers.js';

type Params = {
  /** How many tasks of one pool run at once. */
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
  /** The timers delays and retry waits run on. The page's own by default. */
  timers?: Pick<Timers, 'setTimeout' | 'clearTimeout'>;
};

type TaskParams = {
  /** Tasks share capacity only with tasks of the same pool. */
  pool?: string;
  /** Aborting rejects the task with the signal's reason and frees its slot at once. */
  signal?: AbortSignal;
  /** The wait before the task is queued. `settle` counts it as pending meanwhile. */
  delay?: number;
};

type Task = {
  readonly work: () => unknown;
  readonly pool: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
  readonly signal: AbortSignal | undefined;
  retry: number;
  // The pending delay or retry wait.
  timer: unknown;
  onAbort: (() => void) | undefined;
};

export type AsyncTaskPool = ReturnType<typeof createAsyncTaskPool>;

const DEFAULT_POOL = 'default';

/** Runs tasks in named pools of bounded size, with retries and abort. */
export function createAsyncTaskPool({
  poolSize,
  retryCount = 0,
  retryDelay = 0,
  retryIf,
  timers = realTimers,
}: Params) {
  const queue: Task[] = [];
  const running = new Set<Task>();
  const waiting = new Set<Task>();
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
          timer: undefined,
          onAbort: undefined,
        };
        if (signal !== undefined) {
          task.onAbort = () => {
            abort(task);
          };
          signal.addEventListener('abort', task.onAbort, { once: true });
        }
        if (delay > 0) {
          queueAfter(task, delay);
          return;
        }
        queue.push(task);
        pump(task.pool);
      });
    },
    /** Resolves once the pool has nothing queued, running, delayed or waiting to retry. */
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
      // A task whose signal is already aborted is left for its own abort listener, which may not have run yet when
      // another task on the same signal frees a slot.
      const index = queue.findIndex(task => task.pool === pool && task.signal?.aborted !== true);
      if (index < 0) {
        break;
      }
      const [task] = queue.splice(index, 1);
      if (task !== undefined) {
        running.add(task);
        void run(task);
      }
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
    try {
      const value = await task.work();
      if (running.has(task)) {
        finish(task);
        task.resolve(value);
      }
    } catch (error) {
      // An aborted task was already rejected with the signal's reason.
      if (!running.has(task)) {
        return;
      }
      let delay: number | undefined;
      try {
        const retry = task.retry < retryCount && (retryIf?.(error) ?? true);
        delay = retry ? getRetryDelay(task.retry, error) : undefined;
      } catch (callbackError) {
        // A throwing retryIf or retryDelay must still settle the call, and the task's own failure stays visible.
        finish(task);
        task.reject(new AggregateError([callbackError, error], 'Could not decide whether to retry the task'));
        return;
      }
      if (delay === undefined) {
        finish(task);
        task.reject(error);
        return;
      }
      task.retry += 1;
      queueAfter(task, delay);
    } finally {
      running.delete(task);
      pump(task.pool);
    }
  }

  /** Queues the task once `ms` has passed. Until then it is waiting, so `settle` holds and an abort clears it. */
  function queueAfter(task: Task, ms: number): void {
    waiting.add(task);
    task.timer = timers.setTimeout(() => {
      waiting.delete(task);
      task.timer = undefined;
      queue.push(task);
      pump(task.pool);
    }, ms);
  }

  function abort(task: Task): void {
    timers.clearTimeout(task.timer);
    const index = queue.indexOf(task);
    if (index >= 0) {
      queue.splice(index, 1);
    }
    running.delete(task);
    waiting.delete(task);
    task.reject(task.signal?.reason);
    pump(task.pool);
  }

  function finish(task: Task): void {
    if (task.onAbort !== undefined) {
      task.signal?.removeEventListener('abort', task.onAbort);
    }
  }

  function hasRoom(pool: string): boolean {
    if (poolSize === Number.POSITIVE_INFINITY) {
      return true;
    }
    let count = 0;
    for (const task of running) {
      if (task.pool === pool) {
        count += 1;
        if (count >= poolSize) {
          return false;
        }
      }
    }
    return count < poolSize;
  }

  function isIdle(pool: string): boolean {
    for (const tasks of [queue, running, waiting]) {
      for (const task of tasks) {
        if (task.pool === pool) {
          return false;
        }
      }
    }
    return true;
  }

  function getRetryDelay(retry: number, error: unknown): number {
    return typeof retryDelay === 'function' ? retryDelay(retry, error) : retryDelay;
  }
}
