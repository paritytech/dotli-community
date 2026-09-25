// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A value held twice: in a plain variable for non-UI code, and in a Solid
 * signal for components.
 *
 * Solid 2 batches signal writes, so reading a signal right after writing it
 * outside a reactive scope returns the old value until the next flush. Non-UI
 * code (the bridge, host callbacks) writes then reads within one call, so it
 * reads `get()`, which is always current. Components read `read()` and see the
 * change after the flush.
 */

import { createSignal } from "solid-js";

export interface SyncStore<T> {
  /** Reactive accessor. Components only. */
  read: () => T;
  /** Latest written value, immediately. For non-UI code. */
  get: () => T;
  /** The only writer. */
  set: (next: T) => void;
  /** Restore the initial value. Tests only. */
  reset: () => void;
}

const registry = new Set<() => void>();

export function createSyncStore<T>(initial: T): SyncStore<T> {
  let current = initial;
  // Value form, not a compute function: in Solid 2 a function first argument
  // makes a derived signal. The cast is needed because the value overload
  // excludes function types; stores never hold functions.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type -- mirrors createSignal's own overload
  const [read, write] = createSignal<T>(initial as Exclude<T, Function>);
  const set = (next: T): void => {
    current = next;
    // Wrapped so a function-valued T is stored, not called as an updater.
    write(() => next);
  };
  const reset = (): void => {
    set(initial);
  };
  registry.add(reset);
  return { read, get: () => current, set, reset };
}

/** Restore every store created so far to its initial value. Tests only. */
export function resetAllStoresForTests(): void {
  for (const reset of registry) {
    reset();
  }
}
