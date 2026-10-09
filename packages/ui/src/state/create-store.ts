// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Solid-free because boot-path code imports stores, and Solid's reactive core would otherwise ship
// before any component reads one. Components read a store through `useStore`.

import { captureException } from '@dotli/metrics';

export interface ReadableStore<T> {
  get: () => T;
  /** What a build-time render shows, as nothing writes a store then. */
  initial: T;
  /**
   * Notifications are synchronous, so a listener calling another store's setter runs that nested set,
   * its listeners and its window event before the outer setter dispatches its own event.
   */
  subscribe: (listener: () => void) => () => void;
}

export interface SyncStore<T> extends ReadableStore<T> {
  /** A value equal to the current one is dropped and notifies nobody. */
  set: (next: T) => void;
  /** Tests only. */
  reset: () => void;
}

export interface SyncStoreOptions<T> {
  /**
   * Stores whose producers rebuild an object on every write pass {@link shallowEqual}. Window events
   * from a store's setters fire whether or not the set was dropped.
   */
  equals?: (current: T, next: T) => boolean;
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
      } catch (err) {
        // A broken UI listener must not stop the producer's event dispatch.
        captureException(err, {
          flow: 'ui',
          step: 'store_listener',
          tags: { store: name, kind: 'store_listener_error' },
        });
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

/** Tests only, for module state kept beside a store. */
export function registerStoreStateReset(reset: () => void): void {
  registry.add(reset);
}

export function resetAllStoresForTests(): void {
  for (const reset of registry) {
    reset();
  }
}
