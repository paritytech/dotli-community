// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Lazy entry points, each its own chunk, so the page boot leaves them out.

import type * as ProductCardNamespace from './ProductCard.js';

/** The product card. Rejects when its chunk fails to load. */
export function loadProductCard(): Promise<typeof ProductCardNamespace> {
  return import('./ProductCard.js');
}
