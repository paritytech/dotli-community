// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Plain stores with no framework in them. Components read one through `useStore` in `@dotli/ui`.

export type ReadableStore<T> = {
  get: () => T;
  /** What a build-time render shows, as nothing writes a store then. */
  initial: T;
  /**
   * Notifications are synchronous, so a listener calling another store's setter runs that nested set
   * and its listeners before the outer setter notifies its own.
   */
  subscribe: (listener: () => void) => () => void;
};

export type SyncStore<T> = {
  /** A value equal to the current one is dropped and notifies nobody. */
  set: (next: T) => void;
  /** Tests only. */
  reset: () => void;
} & ReadableStore<T>;

export type SyncStoreOptions<T> = {
  /**
   * Stores whose producers rebuild an object on every write pass {@link shallowEqual}.
   */
  equals?: (current: T, next: T) => boolean;
  /**
   * Hears a listener that threw, wrapped as `store <name> listener failed` with the throw as its cause. The default
   * rethrows it in a microtask, so the page's global error handler reports it and the producer's `set` still
   * completes. This package cannot depend on metrics.
   */
  onListenerError?: (error: Error) => void;
};

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

/** One level only: a nested object must be the same reference. */
export function shallowEqual<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) {
    return true;
  }
  if (
    typeof a !== 'object' ||
    typeof b !== 'object' ||
    a === null ||
    b === null ||
    Array.isArray(a) !== Array.isArray(b)
  ) {
    return false;
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) {
    return false;
  }
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(right, key) || !Object.is(left[key], right[key])) {
      return false;
    }
  }
  return true;
}

const registry = new Set<() => void>();

/** `name` tags a failing listener's report, so it says which store dispatched. */
export function createSyncStore<T>(name: string, initial: T, options: SyncStoreOptions<T> = {}): SyncStore<T> {
  let current = initial;
  const listeners = new Set<() => void>();
  const equals = options.equals ?? Object.is;
  const onListenerError = options.onListenerError ?? rethrowInMicrotask;

  const set = (next: T): void => {
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
  };

  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const reset = (): void => {
    set(initial);
  };
  registry.add(reset);

  return { get: () => current, initial, set, subscribe, reset };
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
