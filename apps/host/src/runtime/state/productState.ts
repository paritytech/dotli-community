// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ProductId } from '@parity/truapi';
import { registerAtomReset } from '@dotli/shared';
import { atom, type ReadableAtom } from 'nanostores';
import type { ProductFacts } from '../../getProductFacts.js';

/** What the page knows of the loaded product beside its label. */
export type ProductDetails = {
  /** Only for a dotNS product, not a local or preview URL. */
  cid?: string;
  /** Whether it declares chat. */
  chat?: boolean;
  /** What its manifests publish. None by default. */
  facts?: ProductFacts;
};

/** `loadId` moves on every load, so a reload of the product already on show still notifies subscribers. */
export type ProductState =
  | { status: 'none'; loadId: number }
  | ({ status: 'loaded'; loadId: number; label: string; productId: ProductId; facts: ProductFacts } & Omit<
      ProductDetails,
      'facts'
    >)
  | { status: 'error'; loadId: number };

type Params = {
  label: string;
  /** The id the core parsed for the product. */
  productId: ProductId;
  /** None by default. */
  details?: ProductDetails;
};

const product = atom<ProductState>({ status: 'none', loadId: 0 });
registerAtomReset(product);
const store: ReadableAtom<ProductState> = product;

/** The product on show, or how its last load ended. */
export const productState = {
  /** The product on show. Every load notifies, a reload of the same product included. */
  store,
  /** Records a render that put the product on screen, its first or a reload. Never throws. */
  setLoaded,
  /** Records a load that ended without the product on screen. Never throws. */
  setError,
};

function setLoaded({ label, productId, details = {} }: Params): void {
  product.set({
    status: 'loaded',
    loadId: product.get().loadId + 1,
    label,
    productId,
    ...details,
    facts: details.facts ?? {},
  });
}

function setError(): void {
  product.set({ status: 'error', loadId: product.get().loadId + 1 });
}
