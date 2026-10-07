// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ShieldState } from '../verification-shield.js';
import { createSyncStore, shallowEqual, type ReadableStore } from './create-store.js';

/**
 * `none` hides the URL bar, on the landing page and until main.ts knows the product.
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

/** The shield, its explainer and their island all read it here, so they agree. */
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
