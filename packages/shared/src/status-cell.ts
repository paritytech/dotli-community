// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The status a layer publishes to the layer above. Reporting a listener's throw is injected, since this package cannot
// depend on metrics.

import { toError } from './errors.js';
import { createListenerSet, type ListenerSetOptions } from './listener-set.js';
import type { ReadableStore } from './sync-store.js';

export type StatusCellOptions<T> = ListenerSetOptions<T>;

export type StatusCell<T> = {
  get: () => T;
  /** Does nothing when `next` is the status already. */
  set: (next: T) => void;
  /** Called on each change only, in order. A listener subscribed twice is two subscriptions. */
  subscribe: (listener: (value: T) => void) => () => void;
};

export function createStatusCell<T>(initial: T, options: StatusCellOptions<T>): StatusCell<T> {
  let value = initial;
  const listeners = createListenerSet<T>(options);
  return {
    get: () => value,
    set: next => {
      if (next === value) {
        return;
      }
      value = next;
      listeners.emit(next);
    },
    subscribe: listeners.subscribe,
  };
}

/**
 * Waits on the status until `verdict` settles the wait with `true` or fails it with an error, and fails with the
 * signal's reason when `signal` aborts first.
 */
export function untilStatus<T>(
  cell: Pick<StatusCell<T>, 'get' | 'subscribe'>,
  verdict: (status: T) => boolean | Error,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // A wait aborted before it began leaves nothing to start.
    if (signal?.aborted === true) {
      reject(toError(signal.reason));
      return;
    }
    let unsubscribe = (): void => undefined;
    let settled = false;
    /** Whether `next` settled the wait. */
    const onStatus = (next: T): boolean => {
      const outcome = verdict(next);
      if (outcome === false) {
        return false;
      }
      settle(outcome === true ? null : outcome);
      return true;
    };
    const onAbort = (): void => {
      settle(toError(signal?.reason));
    };
    function settle(error: Error | null): void {
      if (settled) {
        return;
      }
      settled = true;
      unsubscribe();
      signal?.removeEventListener('abort', onAbort);
      if (error === null) {
        resolve();
      } else {
        reject(error);
      }
    }
    // The status there is now settles the wait at once, so a cell already there costs no subscription.
    if (onStatus(cell.get())) {
      return;
    }
    unsubscribe = cell.subscribe(onStatus);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** A sync store read as a status, so `untilStatus` can wait on it. */
export function storeStatus<T>(
  store: Pick<ReadableStore<T>, 'get' | 'subscribe'>,
): Pick<StatusCell<T>, 'get' | 'subscribe'> {
  return {
    get: store.get,
    subscribe: listener =>
      store.subscribe(() => {
        listener(store.get());
      }),
  };
}
