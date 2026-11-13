// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What the page records and titles of a product once it is on screen.

import type { ProductId } from '@parity/truapi';
import type { FrameProduct, TitledProduct } from './createProductFrame.js';
import type { productState } from './state/productState.js';

type Connection = {
  /** The id the core parsed, so chat data is keyed as the core keys it. */
  productId: ProductId;
  /** Whether its connection serves chat. */
  chat: boolean;
};

/** What the page records of `product` once it is on screen over its connection. */
export function toLoadedProduct(
  product: FrameProduct,
  { productId, chat }: Connection,
): Parameters<typeof productState.setLoaded>[0] {
  switch (product.mode) {
    case 'iframe':
      return {
        label: product.label,
        productId,
        details: { chat },
      };
    case 'subdomain':
      return {
        label: product.label,
        productId,
        details: { cid: product.cid, chat, facts: product.facts },
      };
  }
}

/** The tab's view of a product: a local or preview URL has no root manifest to name it. */
export function toTitledProduct(product: FrameProduct): TitledProduct {
  return product.mode === 'subdomain' && product.facts.displayName !== undefined
    ? { mode: product.mode, label: product.label, displayName: product.facts.displayName }
    : { mode: product.mode, label: product.label };
}
