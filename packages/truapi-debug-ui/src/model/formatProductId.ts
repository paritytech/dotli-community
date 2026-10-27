// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** A product id, or `(no id)` when there is none. Never throws. */
export function formatProductId(productId: string | null | undefined): string {
  return productId ?? '(no id)';
}
