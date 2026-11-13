// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { asProductId } from '@parity/truapi';
import { describe, expect, it } from 'vitest';
import { toProductId } from '../runtime/getAskedProductId.js';
import { parsePolkadotAccount } from '../runtime/polkadotAccount.js';
import type { ProductState } from '../runtime/state/productState.js';
import { getProductCardView } from './productCardView.js';
import type { ProductCardState } from './productCardState.js';
import type { UrlPillState } from './urlPillState.js';

const PRODUCT_ID = asProductId(toProductId('swap'));
const PRODUCT_PILL: UrlPillState = { kind: 'product', domain: 'swap', tld: '.dot', shield: 'verified' };
const CARD: ProductCardState = {
  icon: 'blob:icon',
  author: { status: 'ready', author: { address: parsePolkadotAccount('5Author'), username: null } },
};

describe('product card view', () => {
  it.each<[string, ProductState, UrlPillState]>([
    ['no product', { status: 'none', loadId: 0 }, PRODUCT_PILL],
    ['a failed load', { status: 'error', loadId: 1 }, PRODUCT_PILL],
    ['a local product', { status: 'loaded', loadId: 1, label: 'swap', productId: PRODUCT_ID, facts: {} }, PRODUCT_PILL],
    [
      'a published product on localhost',
      { status: 'loaded', loadId: 1, label: 'swap', productId: PRODUCT_ID, cid: 'bafy', facts: {} },
      { kind: 'localhost', host: 'localhost' },
    ],
  ])('As a visitor, I see no product card for %s', (_name, product, pill) => {
    // Given the card's own state, which is set whatever the page shows
    const card = CARD;

    // When the card's view is taken
    const view = getProductCardView({ product, pill, card });

    // Then there is no view to show
    expect(view).toBeNull();
  });

  it('As a visitor of a published product, I see its name, domain, description, icon, author and connection', () => {
    // Given a loaded product with a name and a description
    const product: ProductState = {
      status: 'loaded',
      loadId: 1,
      label: 'swap',
      productId: PRODUCT_ID,
      cid: 'bafy',
      facts: { displayName: 'Swap', description: 'Trade tokens.' },
    };

    // When the card's view is taken
    const view = getProductCardView({ product, pill: PRODUCT_PILL, card: CARD });

    // Then the view carries each part
    expect(view).toEqual({
      name: 'Swap',
      domain: 'swap.dot',
      description: 'Trade tokens.',
      icon: 'blob:icon',
      author: CARD.author,
      connection: 'verified',
    });
  });

  it.each([
    ['no root manifest', undefined],
    ['an empty description', ''],
  ])('As a visitor of a product with %s, I see it named by its label with no description', (_name, description) => {
    // Given a loaded product that has no usable description
    const product: ProductState = {
      status: 'loaded',
      loadId: 1,
      label: 'swap',
      productId: PRODUCT_ID,
      cid: 'bafy',
      facts: description === undefined ? {} : { description },
    };

    // When the card's view is taken
    const view = getProductCardView({ product, pill: PRODUCT_PILL, card: CARD });

    // Then the label names it and there is no description
    expect(view).toMatchObject({ name: 'swap', description: null });
  });
});
