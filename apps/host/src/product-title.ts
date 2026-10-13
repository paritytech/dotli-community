// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The tab title has one writer, so a product re-render cannot undo the name its root manifest published.

import { SITE_ID, withActiveTld } from '@dotli/config';
import { getActiveRootManifest, type TitledProduct } from '@dotli/host-runtime';

/** The tab title for a product, preferring the display name its root manifest publishes. */
export function productTitle(product: TitledProduct, displayName: string | undefined): string {
  if (product.mode === 'iframe') {
    return `${product.label} · ${SITE_ID}`;
  }
  return displayName ?? withActiveTld(product.label);
}

/** Reads the display name at call time, so a render after the manifest arrived keeps it. */
export function showProductTitle(
  product: TitledProduct,
  setTitle: (title: string) => void = title => {
    document.title = title;
  },
): void {
  setTitle(productTitle(product, getActiveRootManifest()?.displayName));
}
