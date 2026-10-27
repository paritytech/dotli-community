// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** A TrUAPI call's identity. `requestId` is minted per product, so two products in one tab can share it. */
export function getCallKey(event: { readonly productId?: string | undefined; readonly requestId: string }): string {
  return `${event.productId ?? 'dotli'}::${event.requestId}`;
}
