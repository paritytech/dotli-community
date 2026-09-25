// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, getOwner, onCleanup, type Accessor } from "solid-js";
import type { ReadableStore } from "../state/create-store";

/**
 * Read a store from a component. Returns a Solid accessor that follows the
 * store and unsubscribes when the owning component is disposed. Call it inside
 * a component or another reactive owner.
 */
export function useStore<T>(store: ReadableStore<T>): Accessor<T> {
  if (!getOwner()) {
    throw new Error(
      "useStore must be called inside a component or reactive owner",
    );
  }

  // Value form, not a compute function: in Solid 2 a function first argument
  // makes a derived signal. Stores never hold functions.
  const [value, setValue] = createSignal<T>(
    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type -- mirrors createSignal's own overload
    store.get() as Exclude<T, Function>,
    {
      // The store notifies subscribers synchronously and unconditionally, from
      // whatever owner happens to be active when a producer calls `set` (e.g. a
      // `createRoot` scope, not this accessor's own owner). Solid 2's dev build
      // otherwise throws REACTIVE_WRITE_IN_OWNED_SCOPE for that write; this
      // mirror signal is meant to be written from other owners, so it opts out.
      ownedWrite: true,
    },
  );
  const unsubscribe = store.subscribe(() => {
    // Wrapped so a function-valued T would be stored, not called as an updater.
    const next = store.get();
    setValue(() => next);
  });
  onCleanup(unsubscribe);
  return value;
}
