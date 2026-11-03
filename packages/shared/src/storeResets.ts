// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

const registry = new Set<() => void>();

/** Adds a store, or module state kept beside one, to what `resetAllStoresForTests` resets. */
export function registerStoreStateReset(reset: () => void): void {
  registry.add(reset);
}

/** The shape of a store with a fixed starting value, such as an atom. */
type ResettableStore<Value> = {
  readonly init: Value;
  set(value: Value): void;
};

/** Adds an atom-shaped store to what `resetAllStoresForTests` resets, back to its own initial value. */
export function registerAtomReset<Value>(store: ResettableStore<Value>): void {
  registerStoreStateReset(() => {
    store.set(store.init);
  });
}

/** Runs every registered reset in registration order. Tests only, through `@dotli/shared/testing`. */
export function resetAllStoresForTests(): void {
  for (const reset of registry) {
    reset();
  }
}
