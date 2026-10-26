// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** The item at `index`, or a throw naming the index when there is none. */
export function nth<T>(items: ArrayLike<T>, index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`expected an element at index ${String(index)}`);
  }
  return item;
}
