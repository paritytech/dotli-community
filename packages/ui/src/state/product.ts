// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSyncStore } from "./create-store";

export type ProductState =
  | { status: "none" }
  | { status: "loaded"; label: string; productId: string }
  | { status: "error" };

const product = createSyncStore<ProductState>({ status: "none" });

export const productState = product.read;
export const getProductState = product.get;

/** Also dispatches `dotli:product-loaded` with `{ label, productId }`. */
export function setProductLoaded(label: string, productId: string): void {
  product.set({ status: "loaded", label, productId });
  window.dispatchEvent(
    new CustomEvent("dotli:product-loaded", { detail: { label, productId } }),
  );
}

/** Also dispatches `dotli:product-error` with no detail. */
export function setProductError(): void {
  product.set({ status: "error" });
  window.dispatchEvent(new CustomEvent("dotli:product-error"));
}
