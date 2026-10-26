// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Plain stores with no framework in them. Components read one through `useStore` in `@dotli/ui`.

export type ReadableStore<T> = {
  /** The current value. Never throws. */
  get: () => T;
  /** What a build-time render shows, as nothing writes a store then. */
  initial: T;
  /**
   * Notifications are synchronous, so a listener calling another store's setter runs that nested set
   * and its listeners before the outer setter notifies its own.
   */
  subscribe: (listener: () => void) => () => void;
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

const registry = new Set<() => void>();

/** A plain store that notifies its subscribers synchronously on each change. */
export function createSyncStore<T>({
  name,
  initial,
  equals = Object.is,
  onListenerError = rethrowInMicrotask,
}: Params<T>) {
  let current = initial;
  const listeners = new Set<() => void>();
  registry.add(reset);

  return {
    get,
    /** What a build-time render shows, as nothing writes a store then. */
    initial,
    /** A value equal to the current one is dropped and notifies nobody. */
    set,
    /**
     * Notifications are synchronous, so a listener calling another store's setter runs that nested set
     * and its listeners before the outer setter notifies its own.
     */
    subscribe,
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
    current = next;
    // Snapshot so a listener that unsubscribes (itself or another) during
    // notification neither skips nor repeats anyone in this round.
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (cause) {
        // A broken UI listener must not stop the producer's event dispatch.
        onListenerError(new StoreListenerError(name, cause));
      }
    }
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
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

/** Adds module state kept beside a store to what `resetAllStoresForTests` resets. */
export function registerStoreStateReset(reset: () => void): void {
  registry.add(reset);
}

/** Tests only, through `@dotli/shared/testing`. */
export function resetAllStoresForTests(): void {
  for (const reset of registry) {
    reset();
  }
}

function rethrowInMicrotask(error: Error): void {
  queueMicrotask(() => {
    throw error;
  });
}
