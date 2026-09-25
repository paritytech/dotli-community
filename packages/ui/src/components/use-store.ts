// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, onCleanup, type Accessor } from "solid-js";
import type { ReadableStore } from "../state/create-store";

/**
 * Read a store from a component. Returns a Solid accessor that follows the
 * store and unsubscribes when the owning component is disposed. Call it inside
 * a component or another reactive owner.
 */
export function useStore<T>(store: ReadableStore<T>): Accessor<T> {
  // Value form, not a compute function: in Solid 2 a function first argument
  // makes a derived signal. Stores never hold functions.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type -- mirrors createSignal's own overload
  const [value, setValue] = createSignal<T>(store.get() as Exclude<T, Function>);
  const unsubscribe = store.subscribe(() => {
    // Wrapped so a function-valued T would be stored, not called as an updater.
    const next = store.get();
    setValue(() => next);
  });
  onCleanup(unsubscribe);
  return value;
}
