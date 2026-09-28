// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A value plus the listeners that want to hear when it changes. Deliberately
 * free of Solid: stores are imported by boot-path code (bridge, topbar, host
 * callbacks, the sandbox's error screen), and Solid's reactive core would
 * otherwise ship on those eager paths before any component reads a store.
 * Components read a store through the `useStore` helper in `components/`.
 */

import { captureException } from "@dotli/metrics/sentry";

export interface ReadableStore<T> {
  /** Latest written value, immediately. */
  get: () => T;
  /**
   * Called synchronously after every set that changed the value (see
   * {@link SyncStoreOptions.equals}). Returns the unsubscribe.
   * Notifications are synchronous. A listener that calls another store's
   * setter (the auth controller, the chat panel's rules) runs that nested
   * set, its listeners and its window event, before the outer setter
   * dispatches its own event.
   */
  subscribe: (listener: () => void) => () => void;
}

export interface SyncStore<T> extends ReadableStore<T> {
  /**
   * The only writer: updates the value, then notifies listeners in order. A
   * value equal to the current one (see {@link SyncStoreOptions.equals}) is
   * dropped: the store keeps the value it holds and notifies nobody.
   */
  set: (next: T) => void;
  /** Restore the initial value. Tests only. */
  reset: () => void;
}

export interface SyncStoreOptions<T> {
  /**
   * Whether `next` would change nothing over `current`, so the set is
   * dropped. Defaults to `Object.is`, which drops only a set of the value
   * already held. Stores whose producers rebuild an object on every write
   * pass {@link shallowEqual}. Window events dispatched by a store's setter
   * functions are not notifications: they fire whether or not the set was
   * dropped.
   */
  equals?: (current: T, next: T) => boolean;
}

/**
 * `Object.is` for primitives; for two arrays or two plain objects, the same
 * length or keys with `Object.is`-equal values. One level only: a nested
 * object must be the same reference.
 */
export function shallowEqual<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) {
    return true;
  }
  if (
    typeof a !== "object" ||
    typeof b !== "object" ||
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
    if (
      !Object.prototype.hasOwnProperty.call(right, key) ||
      !Object.is(left[key], right[key])
    ) {
      return false;
    }
  }
  return true;
}

const registry = new Set<() => void>();

export function createSyncStore<T>(
  initial: T,
  options: SyncStoreOptions<T> = {},
): SyncStore<T> {
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
        captureException(err, { kind: "store_listener_error" });
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

  return { get: () => current, set, subscribe, reset };
}

/**
 * Also run `reset` whenever {@link resetAllStoresForTests} runs, for module
 * state kept beside a store. Tests only.
 */
export function registerStoreStateReset(reset: () => void): void {
  registry.add(reset);
}

/** Restore every store created so far to its initial value. Tests only. */
export function resetAllStoresForTests(): void {
  for (const reset of registry) {
    reset();
  }
}
