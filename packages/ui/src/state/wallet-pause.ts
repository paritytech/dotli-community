// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Why this page stopped signing with the local wallet. It never un-pauses: resuming reloads the page.

import { createSyncStore, type ReadableStore } from './create-store.js';

/**
 * `moved`: another tab took the wallet. `changed`: another tab saved or forgot it. `lost`: the protocol frame holding
 * this page's lease went away, so another tab may already sign.
 */
export type WalletPauseReason = 'moved' | 'changed' | 'lost';

export interface WalletPauseState {
  reason: WalletPauseReason | null;
  /** The user asked for the wallet back and the page is reloading. */
  resuming: boolean;
}

const walletPause = createSyncStore<WalletPauseState>('walletPause', { reason: null, resuming: false });

export const walletPauseStore: ReadableStore<WalletPauseState> = walletPause;

/** The first reason sticks, since any of them already means this page must reload to sign. */
export function pauseLocalWallet(reason: WalletPauseReason): boolean {
  if (walletPause.get().reason !== null) {
    return false;
  }
  walletPause.set({ reason, resuming: false });
  return true;
}

export function markLocalWalletResuming(): void {
  const { reason } = walletPause.get();
  if (reason !== null) {
    walletPause.set({ reason, resuming: true });
  }
}

/** Tests only. */
export const resetWalletPauseForTests = walletPause.reset;
