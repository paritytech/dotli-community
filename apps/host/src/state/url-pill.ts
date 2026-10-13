// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSyncStore, shallowEqual, type ReadableStore } from '@dotli/shared';

/** "verified" means the visitor's light client checked it, "trusted" means an RPC provider did. */
export type ShieldState = 'verified' | 'trusted';

/**
 * `none` hides the URL bar until main.ts knows the product.
 * `shield` is null until the host knows how the product was loaded.
 */
export type UrlPillState =
  | { kind: 'none' }
  | { kind: 'localhost'; host: string }
  | {
      kind: 'product';
      domain: string;
      tld: string;
      shield: ShieldState | null;
    };

const urlPill = createSyncStore<UrlPillState>('url_pill', { kind: 'none' }, { equals: shallowEqual });

export const urlPillStore: ReadableStore<UrlPillState> = urlPill;

/** Undefined for any pill but a product's, null until the host knows how the product loaded. */
export function pillShield(state: UrlPillState): ShieldState | null | undefined {
  return state.kind === 'product' ? state.shield : undefined;
}

/** A local product, from the localhost proxy or a preview route. */
export function showLocalhostPill(host: string): void {
  urlPill.set({ kind: 'localhost', host });
}

/** A `.dot` product: `domain` is its label, `tld` the active TLD suffix. */
export function showProductPill(domain: string, tld: string): void {
  urlPill.set({ kind: 'product', domain, tld, shield: null });
}

export function setVerificationShieldState(state: ShieldState): void {
  const current = urlPill.get();
  if (current.kind === 'product') {
    urlPill.set({ ...current, shield: state });
  }
}

/** Back to the empty URL bar. Tests only: the host never resets the pill. */
export function resetUrlPill(): void {
  urlPill.set({ kind: 'none' });
}
