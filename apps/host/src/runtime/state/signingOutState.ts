// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { registerAtomReset } from '@dotli/shared';
import { atom, type ReadableAtom } from 'nanostores';

const signingOut = atom<boolean>(false);
registerAtomReset(signingOut);
const store: ReadableAtom<boolean> = signingOut;

/** Whether the page's sign-out is waiting. */
export const signingOutState = {
  /** True while the page's sign-out waits for the sign-out window to read what it ends. */
  store,
  /** Publishes whether the page's sign-out is waiting for the sign-out window. Never throws. */
  set,
};

function set(next: boolean): void {
  signingOut.set(next);
}
