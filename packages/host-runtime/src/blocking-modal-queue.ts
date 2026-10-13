// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createAsyncTaskPool, toAbortError } from '@dotli/shared';

const BLOCKING_MODAL_DISPOSED = 'Blocking modal scope disposed';

type BlockingModalTask<T> = (signal: AbortSignal) => Promise<T> | T;

export interface BlockingModalScope {
  enqueue<T>(task: BlockingModalTask<T>): Promise<T>;
  dispose(reason?: string): void;
}

export interface BlockingModalCoordinator {
  createScope(): BlockingModalScope;
}

/** Prompts queued behind the one on screen, and whether one is up. */
export interface BlockingModalCounts {
  waiting: number;
  active: boolean;
}

export interface BlockingModalCoordinatorOptions {
  /** Hears the counts after every change, so the page can show how busy the queue is. */
  report?: ((counts: BlockingModalCounts) => void) | undefined;
}

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
    const shown = prompts.call(
      () => {
        stage = 'shown';
        waiting -= 1;
        publish();
        // A listener of the counts may have disposed the scope as the prompt came up.
        throwIfAborted(signal);
        return task(signal);
      },
      { signal },
    );
    void shown.then(settle, settle);
    publish();
    return shown;
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
