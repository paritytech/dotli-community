// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { computed, type ReadableAtom } from 'nanostores';
import { productState, type ProductState } from '../page/index.js';
import { productCardState, type AuthorStatus, type ProductCardState } from './productCardState.js';
import { urlPillState, type ShieldState, type UrlPillState } from './urlPillState.js';

/** What the product card shows, joined from the page's stores. */
export type ProductCardView = {
  name: string;
  domain: string;
  description: string | null;
  icon: string | null;
  author: AuthorStatus;
  connection: ShieldState | null;
};

type Params = { product: ProductState; pill: UrlPillState; card: ProductCardState };

/**
 * The card's view, or null while there is no card to show: no product on screen, a local or preview product, or a URL
 * pill that shows no product. Never throws.
 */
export function getProductCardView({ product, pill, card }: Params): ProductCardView | null {
  if (product.status !== 'loaded' || product.cid === undefined || pill.kind !== 'product') {
    return null;
  }
  const domain = `${pill.domain}${pill.tld}`;
  return {
    // With no display name the domain names it, so the card never shows the label above its own domain.
    name: product.facts.displayName ?? domain,
    domain,
    description:
      product.facts.description === undefined || product.facts.description === '' ? null : product.facts.description,
    icon: card.icon,
    author: card.author,
    connection: pill.shield,
  };
}

/** The product card's view, null while there is no card to show. */
export const productCardView: ReadableAtom<ProductCardView | null> = computed(
  [productState.store, urlPillState.store, productCardState.store],
  (product, pill, card) => getProductCardView({ product, pill, card }),
);
