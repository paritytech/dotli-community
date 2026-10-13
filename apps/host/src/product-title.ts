// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The tab title has one writer, the product frame, which hands over the name the product's root manifest published.

import { SITE_ID, withActiveTld } from '@dotli/config';
import type { TitledProduct } from './runtime/product-frame.js';

/** The tab title for a product, preferring the display name its root manifest publishes. */
export function productTitle(product: TitledProduct): string {
  if (product.mode === 'iframe') {
    return `${product.label} · ${SITE_ID}`;
  }
  return product.displayName ?? withActiveTld(product.label);
}

export function showProductTitle(
  product: TitledProduct,
  setTitle: (title: string) => void = title => {
    document.title = title;
  },
): void {
  setTitle(productTitle(product));
}
