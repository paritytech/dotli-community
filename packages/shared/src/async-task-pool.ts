// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Ported from polkadot-desktop's `createAsyncTaskPool`. One place for queueing, bounded concurrency, retries and
// abort, so modules do not grow their own in-flight flags and retry timers.

import { realTimers, type Timers } from './timers.js';

const DEFAULT_POOL = 'default';

export type AsyncTaskPoolParams = {
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

export type AsyncTaskParams = {
  /** Tasks share capacity only with tasks of the same pool. */
  pool?: string;
  /** Aborting rejects the task with the signal's reason and frees its slot at once. */
  signal?: AbortSignal;
  /** The wait before the task is queued. `settle` counts it as pending meanwhile. */
  delay?: number;
};

export type AsyncTaskPool = {
  call<T>(fn: () => T | PromiseLike<T>, params?: AsyncTaskParams): Promise<T>;
  /** Resolves once the pool has nothing queued, running, delayed or waiting to retry. */
  settle(pool?: string): Promise<void>;
};

type Task = {
  readonly fn: () => unknown;
  readonly pool: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
  readonly signal: AbortSignal | undefined;
  retry: number;
  // The pending delay or retry wait.
  timer: unknown;
  onAbort: (() => void) | undefined;
};

/** Runs tasks in named pools of bounded size, with retries and abort. */
export function createAsyncTaskPool(params: AsyncTaskPoolParams): AsyncTaskPool {
  return new TaskPool(params);
}

class TaskPool implements AsyncTaskPool {
  private readonly queue: Task[] = [];
  private readonly running = new Set<Task>();
  private readonly waiting = new Set<Task>();
  private readonly settleWaiters = new Map<string, (() => void)[]>();
  private readonly params: AsyncTaskPoolParams;
  private readonly timers: Pick<Timers, 'setTimeout' | 'clearTimeout'>;

  constructor(params: AsyncTaskPoolParams) {
    this.params = params;
    this.timers = params.timers ?? realTimers;
  }

  call<T>(fn: () => T | PromiseLike<T>, params: AsyncTaskParams = {}): Promise<T> {
    const signal = params.signal;
    if (signal?.aborted === true) {
      return Promise.reject(signal.reason as Error);
    }
    return new Promise<T>((resolve, reject) => {
      const task: Task = {
        fn,
        pool: params.pool ?? DEFAULT_POOL,
        resolve: value => {
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
          this.abort(task);
        };
        signal.addEventListener('abort', task.onAbort, { once: true });
      }
      const delay = params.delay ?? 0;
      if (delay > 0) {
        this.queueAfter(task, delay);
        return;
      }
      this.queue.push(task);
      this.pump(task.pool);
    });
  }

  settle(pool: string = DEFAULT_POOL): Promise<void> {
    if (this.isIdle(pool)) {
      return Promise.resolve();
    }
    return new Promise<void>(resolve => {
      const waiters = this.settleWaiters.get(pool) ?? [];
      waiters.push(resolve);
      this.settleWaiters.set(pool, waiters);
    });
  }

  /** Starts queued tasks of the pool while it has room, then tells `settle` waiters if nothing is left. */
  private pump(pool: string): void {
    while (this.hasRoom(pool)) {
      // A task whose signal is already aborted is left for its own abort listener, which may not have run yet when
      // another task on the same signal frees a slot.
      const index = this.queue.findIndex(task => task.pool === pool && task.signal?.aborted !== true);
      if (index < 0) {
        break;
      }
      const [task] = this.queue.splice(index, 1);
      if (task !== undefined) {
        this.running.add(task);
        void this.run(task);
      }
    }
    const waiters = this.settleWaiters.get(pool);
    if (waiters !== undefined && this.isIdle(pool)) {
      this.settleWaiters.delete(pool);
      for (const resolve of waiters) {
        resolve();
      }
    }
  }

  // Never rejects: the outcome goes to the caller through the task's own promise.
  private async run(task: Task): Promise<void> {
    try {
      const value = await task.fn();
      if (this.running.has(task)) {
        this.finish(task);
        task.resolve(value);
      }
    } catch (error) {
      // An aborted task was already rejected with the signal's reason.
      if (!this.running.has(task)) {
        return;
      }
      let delay: number | undefined;
      try {
        const retry = task.retry < (this.params.retryCount ?? 0) && (this.params.retryIf?.(error) ?? true);
        delay = retry ? this.retryDelay(task.retry, error) : undefined;
      } catch (callbackError) {
        // A throwing retryIf or retryDelay must still settle the call, and the task's own failure stays visible.
        this.finish(task);
        task.reject(new AggregateError([callbackError, error], 'Could not decide whether to retry the task'));
        return;
      }
      if (delay === undefined) {
        this.finish(task);
        task.reject(error);
        return;
      }
      task.retry += 1;
      this.queueAfter(task, delay);
    } finally {
      this.running.delete(task);
      this.pump(task.pool);
    }
  }

  /** Queues the task once `ms` has passed. Until then it is waiting, so `settle` holds and an abort clears it. */
  private queueAfter(task: Task, ms: number): void {
    this.waiting.add(task);
    task.timer = this.timers.setTimeout(() => {
      this.waiting.delete(task);
      task.timer = undefined;
      this.queue.push(task);
      this.pump(task.pool);
    }, ms);
  }

  private abort(task: Task): void {
    this.timers.clearTimeout(task.timer);
    const index = this.queue.indexOf(task);
    if (index >= 0) {
      this.queue.splice(index, 1);
    }
    this.running.delete(task);
    this.waiting.delete(task);
    task.reject(task.signal?.reason);
    this.pump(task.pool);
  }

  private finish(task: Task): void {
    if (task.onAbort !== undefined) {
      task.signal?.removeEventListener('abort', task.onAbort);
    }
  }

  private hasRoom(pool: string): boolean {
    const { poolSize } = this.params;
    if (poolSize === Number.POSITIVE_INFINITY) {
      return true;
    }
    let count = 0;
    for (const task of this.running) {
      if (task.pool === pool) {
        count += 1;
        if (count >= poolSize) {
          return false;
        }
      }
    }
    return count < poolSize;
  }

  private isIdle(pool: string): boolean {
    const inPool = (task: Task): boolean => task.pool === pool;
    if (this.queue.some(inPool)) {
      return false;
    }
    for (const task of this.running) {
      if (inPool(task)) {
        return false;
      }
    }
    for (const task of this.waiting) {
      if (inPool(task)) {
        return false;
      }
    }
    return true;
  }

  private retryDelay(retry: number, error: unknown): number {
    const delay = this.params.retryDelay ?? 0;
    return typeof delay === 'function' ? delay(retry, error) : delay;
  }
}
