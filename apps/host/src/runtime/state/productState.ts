// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSyncStore, type ReadableStore } from '@dotli/shared';
import type { ManifestFacts } from '../manifestFacts.js';

/** What the page knows of the loaded product beside its label. */
export type ProductDetails = {
  /** Only for a dotNS product, not a local or preview URL. */
  cid?: string;
  /** Whether it declares chat. */
  chat?: boolean;
} & ManifestFacts;

/** `loadId` moves on every load, so a reload of the product already on show still notifies subscribers. */
export type ProductState =
  | { status: 'none'; loadId: number }
  | ({ status: 'loaded'; loadId: number; label: string; productId: string } & ProductDetails)
  | { status: 'error'; loadId: number };

type Params = {
  label: string;
  productId: string;
  /** None by default. */
  details?: ProductDetails;
};

const product = createSyncStore<ProductState>({ name: 'product', initial: { status: 'none', loadId: 0 } });
const store: ReadableStore<ProductState> = product;

/** The product on show, or how its last load ended. */
export const productState = {
  /** The product on show. Every load notifies, a reload of the same product included. */
  store,
  /** Returns the product on show. Never throws. */
  get: product.get,
  /** Records a render that put the product on screen, its first or a reload. Never throws. */
  setLoaded,
  /** Records a load that ended without the product on screen. Never throws. */
  setError,
};

function setLoaded({ label, productId, details = {} }: Params): void {
  product.set({ status: 'loaded', loadId: product.get().loadId + 1, label, productId, ...details });
}

function setError(): void {
  product.set({ status: 'error', loadId: product.get().loadId + 1 });
}
