// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

export function nth<T>(xs: ArrayLike<T>, i: number): T {
  const x = xs[i];
  if (x === undefined) {
    throw new Error(`expected an element at index ${String(i)}`);
  }
  return x;
}
