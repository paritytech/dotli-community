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

// A pool's live tasks by phase. `holders` are the running and abandoned tasks, which hold slots.
type PoolTasks = { delayed: Set<Task>; queued: Set<Task>; holders: Set<Task> };

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
  // Each pool's live tasks filed by phase, so room, the next task and idleness are read without walking every task. An
  // entry exists only while its pool has a live task.
  const pools = new Map<string, PoolTasks>();
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
              ? startDelay(delay, () => {
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
        fileTask(task);
        if (task.phase.kind === 'queued') {
          pump(pool);
        }
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
      setPhase(task, { kind: 'running' });
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

  /**
   * Runs the task's work and acts on its outcome by the phase the task is in once it settles. A task runs one work at a
   * time, so a running task is still on this run. Never rejects: the outcome goes to the caller through the task's own
   * promise.
   */
  async function run(task: Task): Promise<void> {
    let result: PromiseSettledResult<unknown>;
    try {
      result = { status: 'fulfilled', value: await task.work() };
    } catch (reason) {
      result = { status: 'rejected', reason };
    }
    switch (task.phase.kind) {
      case 'running':
        finishRun(task, result);
        return;
      case 'abandoned':
        markAbortedDone(task);
        pump(task.pool);
        return;
      case 'done':
        // An abort ended the task and rejected its call.
        return;
      case 'delayed':
      case 'queued':
        // A task waits again only once its run has settled, so none is waiting while its work runs.
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
    // Delayed until its wait passes, so `settle` holds and an abort clears it.
    setPhase(
      task,
      startDelay(delay, () => {
        enqueue(task);
      }),
    );
    pump(task.pool);
  }

  function startDelay(ms: number, onElapsed: () => void): TaskPhase {
    return { kind: 'delayed', timer: timers.setTimeout(onElapsed, ms) };
  }

  /** Puts the task at the end of the queue, behind those queued while it waited, and starts what has room. */
  function enqueue(task: Task): void {
    setPhase(task, { kind: 'queued' });
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
        markAbortedDone(task);
        return;
      case 'queued':
        markAbortedDone(task);
        return;
      case 'running':
        if (holdSlotOnAbort) {
          setPhase(task, { kind: 'abandoned' });
          return;
        }
        markAbortedDone(task);
        return;
      case 'abandoned':
      case 'done':
        // Its call has already settled, so it keeps its phase.
        return;
    }
  }

  function markDone(task: Task): void {
    setPhase(task, { kind: 'done' });
    if (task.onAbort !== undefined) {
      task.signal?.removeEventListener('abort', task.onAbort);
    }
  }

  /**
   * Ends a task whose signal has aborted. Its listener ran once and is gone, and removing it again inside the abort
   * dispatch would scan the signal's whole listener list for each task on it.
   */
  function markAbortedDone(task: Task): void {
    setPhase(task, { kind: 'done' });
  }

  /** Moves the task to a new phase and refiles it, the one place a phase changes after the task is filed. */
  function setPhase(task: Task, next: TaskPhase): void {
    unfileTask(task);
    task.phase = next;
    fileTask(task);
  }

  /** Files the task under its current phase. A queued task goes to the end of its pool's queue. */
  function fileTask(task: Task): void {
    if (task.phase.kind === 'done') {
      return;
    }
    let entry = pools.get(task.pool);
    if (entry === undefined) {
      entry = { delayed: new Set(), queued: new Set(), holders: new Set() };
      pools.set(task.pool, entry);
    }
    switch (task.phase.kind) {
      case 'delayed':
        entry.delayed.add(task);
        return;
      case 'queued':
        entry.queued.add(task);
        return;
      case 'running':
      case 'abandoned':
        entry.holders.add(task);
        return;
    }
  }

  function unfileTask(task: Task): void {
    const entry = pools.get(task.pool);
    if (entry === undefined) {
      return;
    }
    entry.delayed.delete(task);
    entry.queued.delete(task);
    entry.holders.delete(task);
    if (entry.delayed.size + entry.queued.size + entry.holders.size === 0) {
      pools.delete(task.pool);
    }
  }

  /** The head of the pool's queue whose signal has not aborted. */
  function findNext(pool: string): Task | undefined {
    for (const task of pools.get(pool)?.queued ?? []) {
      // A task whose signal is already aborted is left for its own abort listener, which may not have run yet when
      // another task on the same signal frees a slot.
      if (task.signal?.aborted !== true) {
        return task;
      }
    }
    return undefined;
  }

  function hasRoom(pool: string): boolean {
    return (pools.get(pool)?.holders.size ?? 0) < poolSize;
  }

  function isIdle(pool: string): boolean {
    return !pools.has(pool);
  }

  function getRetryDelay(retry: number, error: unknown): number {
    return typeof retryDelay === 'function' ? retryDelay(retry, error) : retryDelay;
  }
}
