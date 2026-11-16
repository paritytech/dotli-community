// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The page's wallet mode. A switch reloads the page. A boot whose wallet read failed runs as `app` until a later read
// finds the wallet.

import { registerAtomReset } from '@dotli/shared';
import { atom, computed, type ReadableAtom } from 'nanostores';

export type WalletMode = 'app' | 'local';

export type WalletModeState = {
  mode: WalletMode;
  /** Why local mode could not start on this boot. */
  failure: string | null;
};

const walletMode = atom<WalletModeState>({ mode: 'app', failure: null });
registerAtomReset(walletMode);
const store: ReadableAtom<WalletModeState> = walletMode;
const localStore: ReadableAtom<boolean> = computed(walletMode, isLocalState);

/** The page's wallet mode, and why local mode could not start. */
export const walletModeState = {
  /** The current mode and the failure that kept local mode from starting. */
  store,
  /** Whether the page runs on a local wallet, for a view that follows it. */
  localStore,
  /**
   * Whether the page runs on a local wallet now. False until the restore settles. It turns true at most once in a
   * page's life, when a wallet read that failed at boot later finds the wallet or the sign-in window starts serving a
   * site, and never turns back without a reload. Never throws.
   */
  isLocal,
  /** Publishes the mode this boot runs in. Never throws. */
  set,
};

function isLocal(): boolean {
  return isLocalState(walletMode.get());
}

function set(next: WalletModeState): void {
  walletMode.set(next);
}

function isLocalState(state: WalletModeState): boolean {
  return state.mode === 'local';
}
