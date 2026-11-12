// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The page's one wallet boot, built on first use, after the page's boot chose its role.

import { createWalletBoot, type LocalWalletBoot, type Restored, type WalletBoot } from './createWalletBoot.js';
import { pageRole } from './pageRole.js';
import { signInFlag } from './session/createCoreStorage.js';
import { reconcilePage } from './session/restoreRule.js';
import { walletModeState } from './state/walletModeState.js';

let boot: WalletBoot | null = null;

/** The page's one wallet boot. Each member throws or rejects when used before the page's boot chose its role. */
export const pageWalletBoot = {
  /**
   * The local wallet the page boots on, or null to boot the pairing host. Rejects before the role is chosen, and when
   * the restore rule breaks its contract and rejects.
   */
  read,
  /**
   * The sign-in window serves a site, so its cores boot on a stored local wallet. Throws only before the role is
   * chosen.
   */
  serveSites,
  /**
   * Settles once the restore rule ran on the page's copy, with what it left. Rejects before the role is chosen, and
   * when the restore rule breaks its contract and rejects.
   */
  restore,
};

async function read(): Promise<LocalWalletBoot | null> {
  return getBoot().read();
}

function serveSites(): void {
  getBoot().serveSites();
}

async function restore(): Promise<Restored> {
  return getBoot().restore();
}

function getBoot(): WalletBoot {
  boot ??= createWalletBoot({
    reconcile: reconcilePage,
    report: walletModeState.set,
    flag: signInFlag,
    role: pageRole.get(),
  });
  return boot;
}
