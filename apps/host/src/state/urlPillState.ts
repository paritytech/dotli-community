// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { isShallowEqual, registerAtomReset } from '@dotli/shared';
import { atom, type ReadableAtom } from 'nanostores';

/** "verified" means the visitor's light client checked it, "trusted" means an RPC provider did. */
export type ShieldState = 'verified' | 'trusted';

/**
 * `none` hides the URL bar until the product is known. `shield` is null until it is known how the product was loaded.
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

const urlPill = atom<UrlPillState>({ kind: 'none' });
urlPill.eq = isShallowEqual;
registerAtomReset(urlPill);
const store: ReadableAtom<UrlPillState> = urlPill;

/** What the URL pill shows: no pill, a local product, or a `.dot` product with its verification shield. */
export const urlPillState = {
  /** The pill's content. Notifies only when a field changes. */
  store,
  /** Returns undefined for any pill but a product's, and null until it is known how the product loaded. Never throws. */
  getPillShield,
  /** Shows a local product, from the localhost proxy or a preview route. Never throws. */
  showLocalhost,
  /** Shows a `.dot` product: `domain` is its label, `tld` the active TLD suffix. Its shield starts null. Never throws. */
  showProduct,
  /** Sets the shown product's verification shield, and does nothing while no product is shown. Never throws. */
  setVerificationShield,
};

function getPillShield(state: UrlPillState): ShieldState | null | undefined {
  switch (state.kind) {
    case 'none':
    case 'localhost':
      return undefined;
    case 'product':
      return state.shield;
  }
}

function showLocalhost(host: string): void {
  urlPill.set({ kind: 'localhost', host });
}

function showProduct(domain: string, tld: string): void {
  urlPill.set({ kind: 'product', domain, tld, shield: null });
}

function setVerificationShield(shield: ShieldState): void {
  const current = urlPill.get();
  if (current.kind !== 'product') {
    return;
  }
  urlPill.set({ ...current, shield });
}
