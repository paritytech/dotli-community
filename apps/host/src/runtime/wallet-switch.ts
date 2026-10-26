// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The switch in place, for a page with no sign-in window. Every switch reloads, so the core boots in the new mode
// instead of being swapped while it runs. A failed switch is reported here and leaves the page as it was, so callers
// only show it.

import { log } from '@dotli/shared';
import { reportLocalWalletFailure } from './wallet-failure.js';
import { signInFlag } from './session/core-storage.js';
import { siteWallet } from './session/site-wallet.js';

/** `reloading` once the switch is stored for every app, `failed` after the failure was reported. */
export type WalletSwitchOutcome = 'reloading' | 'failed';

export type WalletSwitch = {
  /** Uses this wallet in every app on the domain. */
  useLocalWallet(entropy: Uint8Array): Promise<WalletSwitchOutcome>;
  /**
   * Forgets the local wallet in every app on the domain through `forget`, so they sign with Polkadot App again. The
   * caller passes the forget, so it can forget only the record it read.
   */
  usePolkadotApp(forget: () => Promise<void>): Promise<WalletSwitchOutcome>;
};

export type WalletSwitchDeps = {
  save: (entropy: Uint8Array) => Promise<void>;
  reload: () => void;
};

export function createWalletSwitch({ save, reload }: WalletSwitchDeps): WalletSwitch {
  return {
    async useLocalWallet(entropy) {
      try {
        await save(entropy);
      } catch (error) {
        reportLocalWalletFailure(new Error('Local wallet could not be saved', { cause: error }), 'save');
        return 'failed';
      }
      log.event('local wallet saved', { flow: 'wallet' });
      reload();
      return 'reloading';
    },
    async usePolkadotApp(forget) {
      try {
        await forget();
      } catch (error) {
        reportLocalWalletFailure(new Error('Local wallet could not be forgotten', { cause: error }), 'forget');
        return 'failed';
      }
      log.event('local wallet forgotten', { flow: 'wallet' });
      reload();
      return 'reloading';
    },
  };
}

export const walletSwitch: WalletSwitch = createWalletSwitch({
  // Through the page's flag keeper, so a page that owns the flag raises it before the wallet lands in the main store,
  // and a framed preview leaves it alone.
  save: entropy => signInFlag.store(() => siteWallet.save(entropy, null)),
  reload: () => {
    window.location.reload();
  },
});
