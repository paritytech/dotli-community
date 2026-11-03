// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Plain stores with no framework in them. Components read one through `useStore` in `@dotli/stores-solid`.

import { registerStoreStateReset } from './storeResets.js';

export type ReadableStore<T> = {
  /** The current value. Never throws. */
  get: () => T;
  /** The value the store was built with, which a build-time render shows, as nothing writes a store then. */
  init: T | undefined;
  /**
   * Hears each change with the new value and the one it replaced, with no first call. Notifications are synchronous, so
   * a listener calling another store's setter runs that nested set and its listeners before the outer setter notifies
   * its own.
   */
  listen(listener: (value: T, oldValue: T | undefined) => void): () => void;
};

export type SyncStore<T> = ReturnType<typeof createSyncStore<T>>;

type Params<T> = {
  /** Tags a failing listener's report, so it says which store dispatched. */
  name: string;
  initial: T;
  /** Whether `next` equals `current`, in which case a `set` keeps `current` and notifies no listener. */
  equals?: (current: T, next: T) => boolean;
  /**
   * Hears a listener that threw, wrapped as `store <name> listener failed` with the throw as its cause. The default
   * rethrows it in a microtask, so the page's global error handler reports it and the producer's `set` still
   * completes. This package cannot depend on metrics.
   */
  onListenerError?: (error: Error) => void;
};

/**
 * A plain store that notifies its listeners synchronously on each change.
 *
 * @example
 * const view = createSyncStore<View>({ name: 'view', initial, equals });
 * const stop = view.listen(value => render(value));
 */
export function createSyncStore<T>({
  name,
  initial,
  equals = Object.is,
  onListenerError = rethrowInMicrotask,
}: Params<T>) {
  let current = initial;
  const listeners = new Set<(value: T, oldValue: T) => void>();
  registerStoreStateReset(reset);

  return {
    get,
    /** The value the store was built with, which a build-time render shows. */
    init: initial,
    /** A value equal to the current one is dropped and notifies nobody. */
    set,
    /**
     * Hears each change with the new value and the one it replaced, with no first call. Notifications are synchronous,
     * so a listener calling another store's setter runs that nested set and its listeners before the outer setter
     * notifies its own.
     */
    listen,
    /** Tests only. */
    reset,
  };

  function get(): T {
    return current;
  }

  function set(next: T): void {
    if (equals(current, next)) {
      return;
    }
    const previous = current;
    current = next;
    // Snapshot so a listener that unlistens (itself or another) during
    // notification neither skips nor repeats anyone in this round.
    for (const listener of [...listeners]) {
      try {
        listener(next, previous);
      } catch (cause) {
        // A broken UI listener must not stop the producer's event dispatch.
        onListenerError(new StoreListenerError(name, cause));
      }
    }
  }

  function listen(listener: (value: T, oldValue: T) => void): () => void {
    // A fresh wrapper per call, so a listener given twice is two subscriptions that each unlisten alone.
    function callListener(value: T, oldValue: T): void {
      listener(value, oldValue);
    }
    listeners.add(callListener);
    return () => {
      listeners.delete(callListener);
    };
  }

  function reset(): void {
    set(initial);
  }
}

/** A store listener that threw. The page's error handler groups it by `store`. */
export class StoreListenerError extends Error {
  override readonly name = 'StoreListenerError';
  readonly store: string;

  constructor(store: string, cause: unknown) {
    super(`store ${store} listener failed`, { cause });
    this.store = store;
  }
}

function rethrowInMicrotask(error: Error): void {
  queueMicrotask(() => {
    throw error;
  });
}
