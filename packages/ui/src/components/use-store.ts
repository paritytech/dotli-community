// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, getOwner, onCleanup, type Accessor } from "solid-js";
import type { ReadableStore } from "../state/create-store";

/**
 * Read a store from a component. Returns a Solid accessor that follows the
 * store and unsubscribes when the owning component is disposed. Call it inside
 * a component or another reactive owner.
 *
 * With `select`, the accessor holds only that slice of the store's value, and
 * notifies its readers only when the slice changes (by `equals`, `===` by
 * default), so a write to another field re-runs none of them. Prefer a
 * selector over reading one field of the whole value: Solid 2 runs an
 * effect's function every time its compute re-runs, even for an equal value.
 * `select` runs once per store notification. Pass `equals` (for example
 * `shallowEqual`) when `select` builds a new object or array.
 *
 * The accessor lags a synchronous `set`: right after a producer writes, it
 * still returns the old value until Solid's next flush, while `store.get()` is
 * already current. In event handlers and effect functions that act on a value
 * just written, read `store.get()`.
 */
export function useStore<T>(store: ReadableStore<T>): Accessor<T>;
export function useStore<T, S>(
  store: ReadableStore<T>,
  select: (value: T) => S,
  equals?: (prev: S, next: S) => boolean,
): Accessor<S>;
export function useStore<T, S>(
  store: ReadableStore<T>,
  select?: (value: T) => S,
  equals?: (prev: S, next: S) => boolean,
): Accessor<S> {
  if (!getOwner()) {
    throw new Error(
      "useStore must be called inside a component or reactive owner",
    );
  }

  const read = (): S =>
    select === undefined ? (store.get() as unknown as S) : select(store.get());

  // Value form, not a compute function: in Solid 2 a function first argument
  // makes a derived signal. Stores never hold functions.
  const [value, setValue] = createSignal<S>(
    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type -- mirrors createSignal's own overload
    read() as Exclude<S, Function>,
    {
      // The store notifies subscribers synchronously, from whatever owner
      // happens to be active when a producer calls `set` (e.g. a `createRoot`
      // scope, not this accessor's own owner). Solid 2's dev build otherwise
      // throws REACTIVE_WRITE_IN_OWNED_SCOPE for that write; this mirror
      // signal is meant to be written from other owners, so it opts out.
      ownedWrite: true,
      // Drops an unchanged slice here, at the source, so nothing downstream
      // recomputes for it.
      ...(equals === undefined ? {} : { equals }),
    },
  );
  const unsubscribe = store.subscribe(() => {
    // Wrapped so a function-valued slice would be stored, not called as an
    // updater.
    const next = read();
    setValue(() => next);
  });
  onCleanup(unsubscribe);
  return value;
}
