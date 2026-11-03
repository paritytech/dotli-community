// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

const registry = new Set<() => void>();

/** Adds a store, or module state kept beside one, to what `resetAllStoresForTests` resets. */
export function registerStoreStateReset(reset: () => void): void {
  registry.add(reset);
}

/** Runs every registered reset in registration order. Tests only, through `@dotli/shared/testing`. */
export function resetAllStoresForTests(): void {
  for (const reset of registry) {
    reset();
  }
}
