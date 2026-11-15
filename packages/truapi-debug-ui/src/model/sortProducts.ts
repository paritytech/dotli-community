// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** The product ids in name order, with the events that carry none (`undefined`) last. Never throws. */
export function sortProducts(products: readonly (string | undefined)[]): (string | undefined)[] {
  return [...products].sort((left, right) => {
    if (left === undefined) {
      return 1;
    }
    if (right === undefined) {
      return -1;
    }
    return left.localeCompare(right);
  });
}
