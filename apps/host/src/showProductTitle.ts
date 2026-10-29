// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The tab title has one writer, the product frame, which hands over the name the product's root manifest published.

import { SITE_ID, withActiveTld } from '@dotli/config';
import type { TitledProduct } from './runtime/createProductFrame.js';

type Params = {
  /** Writes the tab title, the page's document title by default. */
  setTitle?: ((title: string) => void) | undefined;
};

/** Writes the product's tab title through `setTitle`. Throws only as `setTitle` does. */
export function showProductTitle(product: TitledProduct, { setTitle = setDocumentTitle }: Params = {}): void {
  setTitle(getProductTitle(product));
}

/** The tab title for a product, preferring the display name its root manifest publishes. */
export function getProductTitle(product: TitledProduct): string {
  if (product.mode === 'iframe') {
    return `${product.label} · ${SITE_ID}`;
  }
  return product.displayName ?? withActiveTld(product.label);
}

function setDocumentTitle(title: string): void {
  document.title = title;
}
