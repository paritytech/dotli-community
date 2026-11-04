// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Opens the lazily loaded product card for every surface that shows it, so each opening asks for the author the same way.

import { lazy, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { loadProductCard } from '../../lazy.js';
import type { ProductCardView } from '../../state/productCardView.js';

// Its own chunk, loaded apart from the page's first paint.
const Card = lazy(loadProductCard, { export: 'ProductCard' });

export type OpenProductCardProps = {
  card: ProductCardView;
  /** Called once as the body mounts, which a surface does per opening. */
  onShow: () => void;
};

/** Loads the card's chunk. Resolves when it is loaded and rejects when the chunk fails to load. */
export function preloadProductCard(): Promise<unknown> {
  return Card.preload();
}

/** The card's body, asking for the author once as it mounts and reading the card until the surface closes. */
export function OpenProductCard(props: OpenProductCardProps): JSX.Element {
  // Once per opening, as the surface mounts its body with each one.
  untrack(() => {
    props.onShow();
  });
  return <Card card={props.card} />;
}
