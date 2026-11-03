// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The page's wallet mode. A switch reloads the page. A boot whose wallet read failed runs as `app` until a later read
// finds the wallet.

import { registerAtomReset } from '@dotli/shared';
import { atom, type ReadableAtom } from 'nanostores';

export type WalletMode = 'app' | 'local';

export type WalletModeState = {
  mode: WalletMode;
  /** Why local mode could not start on this boot. */
  failure: string | null;
};

const walletMode = atom<WalletModeState>({ mode: 'app', failure: null });
registerAtomReset(walletMode);
const store: ReadableAtom<WalletModeState> = walletMode;

/** The page's wallet mode, and why local mode could not start. */
export const walletModeState = {
  /** The current mode and the failure that kept local mode from starting. */
  store,
  /** Returns the current mode. Never throws. */
  getMode,
  /** Publishes the mode this boot runs in. Never throws. */
  set,
};

function getMode(): WalletMode {
  return walletMode.get().mode;
}

function set(next: WalletModeState): void {
  walletMode.set(next);
}
