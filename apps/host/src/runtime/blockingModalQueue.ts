// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createAsyncTaskPool, deferred, toAbortError } from '@dotli/shared';

const BLOCKING_MODAL_DISPOSED = 'Blocking modal scope disposed';

/** Keeps the prompt slot taken until `promise` settles. Call it before the task returns. */
export type HoldSlot = (promise: Promise<unknown>) => void;

type BlockingModalTask<T> = (signal: AbortSignal, hold: HoldSlot) => Promise<T> | T;

export type BlockingModalScope = {
  /**
   * Resolves with the task's value as soon as it returns. A promise the task holds keeps the slot, and the counts,
   * taken until it settles or the scope is disposed, so no other prompt covers what it shows. Rejects with an
   * AbortError when the scope is disposed before the task answers, so a caller must handle it.
   */
  enqueue<T>(task: BlockingModalTask<T>): Promise<T>;
  dispose(reason?: string): void;
};

export type BlockingModalCoordinator = {
  createScope(): BlockingModalScope;
};

/** Prompts queued behind the one on screen, and whether one is up. */
export type BlockingModalCounts = {
  waiting: number;
  active: boolean;
};

export type BlockingModalCoordinatorOptions = {
  /** Hears the counts after every change, so the page can show how busy the queue is. */
  report?: ((counts: BlockingModalCounts) => void) | undefined;
};

function blockingModalAbortError(reason?: unknown): DOMException {
  return toAbortError(reason, BLOCKING_MODAL_DISPOSED);
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw blockingModalAbortError(signal.reason);
  }
}

/** One prompt on screen at a time, across every scope. `report` hears how many wait and whether one shows. */
export function createBlockingModalCoordinator({
  report = () => undefined,
}: BlockingModalCoordinatorOptions = {}): BlockingModalCoordinator {
  const prompts = createAsyncTaskPool({ poolSize: 1 });
  let waiting = 0;
  // Shown and waiting prompts together, so the bar never reads idle between two that follow each other.
  let open = 0;
  const publish = (): void => {
    report({ waiting, active: open > 0 });
  };

  const enqueue = <T>(signal: AbortSignal, task: BlockingModalTask<T>): Promise<T> => {
    if (signal.aborted) {
      return Promise.reject(blockingModalAbortError(signal.reason));
    }
    let stage: 'waiting' | 'shown' | 'settled' = 'waiting';
    const settle = (): void => {
      if (stage === 'settled') {
        return;
      }
      if (stage === 'waiting') {
        waiting -= 1;
      }
      stage = 'settled';
      open -= 1;
      signal.removeEventListener('abort', settle);
      publish();
    };
    waiting += 1;
    open += 1;
    // Ahead of this prompt's own abort listener in the pool, so its counts drop before the pool moves on. A later prompt
    // of the same scope can still be started then, and its abort check turns it away before its task runs.
    signal.addEventListener('abort', settle, { once: true });
    const answer = deferred<T>();
    const shown = prompts.call(
      async () => {
        stage = 'shown';
        waiting -= 1;
        publish();
        // A listener of the counts may have disposed the scope as the prompt came up.
        throwIfAborted(signal);
        const held: Promise<unknown>[] = [];
        const value = await task(signal, promise => {
          held.push(promise);
        });
        if (held.length > 0) {
          answer.resolve(value);
          // A held step reports its own failure, so only its end matters here.
          while (held.length > 0) {
            await Promise.allSettled(held.splice(0));
          }
        }
        return value;
      },
      { signal },
    );
    // A task that held answered already, so only the scope's abort is left to reject it, and that changes nothing.
    void shown.then(
      value => {
        settle();
        answer.resolve(value);
      },
      (error: unknown) => {
        settle();
        answer.reject(error);
      },
    );
    publish();
    return answer.promise;
  };

  return {
    createScope: () => {
      const controller = new AbortController();
      return {
        enqueue: task => enqueue(controller.signal, task),
        dispose: (reason = 'TrUAPI host disposed') => {
          if (!controller.signal.aborted) {
            controller.abort(blockingModalAbortError(reason));
          }
        },
      };
    },
  };
}
