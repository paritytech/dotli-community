// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSyncStore, type ReadableStore } from '@dotli/shared';
import type { ManifestFacts } from '../manifest-facts.js';

/** What the page knows of the loaded product beside its label. */
export interface ProductDetails extends ManifestFacts {
  /** Only for a dotNS product, not a local or preview URL. */
  cid?: string;
  /** Whether it declares chat, which picked its connection's execution kind. */
  chat?: boolean;
}

/** `loadId` moves on every load, so a reload of the product already on show still notifies subscribers. */
export type ProductState =
  | { status: 'none'; loadId: number }
  | ({ status: 'loaded'; loadId: number; label: string; productId: string } & ProductDetails)
  | { status: 'error'; loadId: number };

const product = createSyncStore<ProductState>('product', { status: 'none', loadId: 0 });

export const productStore: ReadableStore<ProductState> = product;
export const getProductState = product.get;

/** A render that put the product on screen, its first or a reload. */
export function setProductLoaded(label: string, productId: string, details: ProductDetails = {}): void {
  product.set({ status: 'loaded', loadId: product.get().loadId + 1, label, productId, ...details });
}

/** A load that ended without the product on screen. */
export function setProductError(): void {
  product.set({ status: 'error', loadId: product.get().loadId + 1 });
}
