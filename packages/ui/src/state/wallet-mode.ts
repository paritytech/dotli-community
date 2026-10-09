// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The wallet mode this page booted with. It changes only by reloading, so readers never see a live switch.

import { createSyncStore, type ReadableStore } from './create-store.js';

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
