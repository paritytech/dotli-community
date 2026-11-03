// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { registerStoreStateReset } from '@dotli/shared';
import { atom, type ReadableAtom } from 'nanostores';

const INITIAL = false;

const elsewhere = atom<boolean>(INITIAL);
registerStoreStateReset(() => {
  elsewhere.set(INITIAL);
});
const store: ReadableAtom<boolean> = elsewhere;

/** Whether a sign-in exists on the site that this page does not hold. */
export const sessionElsewhereState = {
  /**
   * True while the page shows signed out and the signed-in flag says a sign-in exists on the site, as in Safari, where a
   * page keeps its own copy and never sees a sign-in made on another product.
   */
  store,
  /** Publishes whether a sign-in exists on the site that this page does not hold. Never throws. */
  set,
};

function set(next: boolean): void {
  elsewhere.set(next);
}
