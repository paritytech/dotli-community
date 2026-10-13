// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The page's wallet mode. A switch reloads the page. A boot whose wallet read failed runs as `app` until a later read
// finds the wallet.

import { createSyncStore, type ReadableStore } from '@dotli/shared';

export type WalletMode = 'app' | 'local';

export interface WalletModeState {
  mode: WalletMode;
  /** Why local mode could not start on this boot. */
  failure: string | null;
}

const walletMode = createSyncStore<WalletModeState>('walletMode', { mode: 'app', failure: null });

export const walletModeStore: ReadableStore<WalletModeState> = walletMode;

export function getWalletMode(): WalletMode {
  return walletMode.get().mode;
}

export function setWalletModeState(next: WalletModeState): void {
  walletMode.set(next);
}
