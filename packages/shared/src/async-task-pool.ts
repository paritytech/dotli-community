// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Ported from polkadot-desktop's `createAsyncTaskPool`. One place for queueing, bounded concurrency, retries and
// abort, so modules do not grow their own in-flight flags and retry timers.

export const DEFAULT_POOL = 'default';

export interface AsyncTaskPoolParams {
  /** How many tasks of one pool run at once. */
  poolSize: number;
  /** Extra attempts after a failure. */
  retryCount?: number;
  /** The wait before a retry, fixed or from the retry's index, which starts at 0. */
  retryDelay?: number | ((retry: number) => number);
}

export interface AsyncTaskParams {
  /** Tasks share capacity only with tasks of the same pool. */
  pool?: string;
  /** Aborting rejects the task with the signal's reason and frees its slot at once. */
  signal?: AbortSignal;
}

export interface AsyncTaskPool {
  call<T>(fn: () => T | PromiseLike<T>, params?: AsyncTaskParams): Promise<T>;
  /** Resolves once the pool has nothing queued, running or waiting to retry. */
  settle(pool?: string): Promise<void>;
}

interface Task {
  readonly fn: () => unknown;
  readonly pool: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
  readonly signal: AbortSignal | undefined;
  retry: number;
  retryTimer: ReturnType<typeof setTimeout> | undefined;
  onAbort: (() => void) | undefined;
}

/** Runs tasks in named pools of bounded size, with retries and abort. */
export function createAsyncTaskPool(params: AsyncTaskPoolParams): AsyncTaskPool {
  return new TaskPool(params);
}

class TaskPool implements AsyncTaskPool {
  private readonly queue: Task[] = [];
  private readonly running = new Set<Task>();
  private readonly retrying = new Set<Task>();
  private readonly settleWaiters = new Map<string, (() => void)[]>();
  private readonly params: AsyncTaskPoolParams;

  constructor(params: AsyncTaskPoolParams) {
    this.params = params;
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
        retryTimer: undefined,
        onAbort: undefined,
      };
      if (signal !== undefined) {
        task.onAbort = () => {
          this.abort(task);
        };
        signal.addEventListener('abort', task.onAbort, { once: true });
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
    while (this.countRunning(pool) < this.params.poolSize) {
      const index = this.queue.findIndex(task => task.pool === pool);
      if (index < 0) {
        break;
      }
      const [task] = this.queue.splice(index, 1);
      if (task !== undefined) {
        this.running.add(task);
        void this.run(task);
      }
    }
    if (this.isIdle(pool)) {
      const waiters = this.settleWaiters.get(pool) ?? [];
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
      if (task.retry >= (this.params.retryCount ?? 0)) {
        this.finish(task);
        task.reject(error);
        return;
      }
      const delay = this.retryDelay(task.retry);
      task.retry += 1;
      this.retrying.add(task);
      task.retryTimer = setTimeout(() => {
        this.retrying.delete(task);
        task.retryTimer = undefined;
        this.queue.push(task);
        this.pump(task.pool);
      }, delay);
    } finally {
      this.running.delete(task);
      this.pump(task.pool);
    }
  }

  private abort(task: Task): void {
    clearTimeout(task.retryTimer);
    const index = this.queue.indexOf(task);
    if (index >= 0) {
      this.queue.splice(index, 1);
    }
    this.running.delete(task);
    this.retrying.delete(task);
    task.reject(task.signal?.reason);
    this.pump(task.pool);
  }

  private finish(task: Task): void {
    if (task.onAbort !== undefined) {
      task.signal?.removeEventListener('abort', task.onAbort);
    }
  }

  private countRunning(pool: string): number {
    let count = 0;
    for (const task of this.running) {
      if (task.pool === pool) {
        count += 1;
      }
    }
    return count;
  }

  private isIdle(pool: string): boolean {
    const inPool = (task: Task): boolean => task.pool === pool;
    return !this.queue.some(inPool) && ![...this.running].some(inPool) && ![...this.retrying].some(inPool);
  }

  private retryDelay(retry: number): number {
    const delay = this.params.retryDelay ?? 0;
    return typeof delay === 'function' ? delay(retry) : delay;
  }
}
