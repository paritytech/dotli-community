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
   * Called synchronously after every set. Returns the unsubscribe.
   * Notifications are synchronous. Listeners must not call store setters: a
   * nested set notifies and dispatches its window event before the outer one
   * does.
   */
  subscribe: (listener: () => void) => () => void;
}

export interface SyncStore<T> extends ReadableStore<T> {
  /** The only writer: updates the value, then notifies listeners in order. */
  set: (next: T) => void;
  /** Restore the initial value. Tests only. */
  reset: () => void;
}

const registry = new Set<() => void>();

export function createSyncStore<T>(initial: T): SyncStore<T> {
  let current = initial;
  const listeners = new Set<() => void>();

  const set = (next: T): void => {
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

/** Restore every store created so far to its initial value. Tests only. */
export function resetAllStoresForTests(): void {
  for (const reset of registry) {
    reset();
  }
}
