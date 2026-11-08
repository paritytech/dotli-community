// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The switch in place, for a page with no sign-in window. Every switch reloads, so the core boots in the new mode
// instead of being swapped while it runs. A failed switch is reported here and leaves the page as it was.

import { createReporter } from '@dotli/metrics';
import { reportLocalWalletFailure } from './walletFailure.js';
import { signInFlag } from './session/createCoreStorage.js';
import { siteWallet } from './session/siteWallet.js';

const report = createReporter({ flow: 'wallet' });

/** `reloading` once the switch is stored for every app, `failed` after the failure was reported. */
export type WalletSwitchOutcome = 'reloading' | 'failed';

type Params = {
  /** Stores `entropy` as the local wallet for every app. Rejects when it could not be stored. */
  save: (entropy: Uint8Array) => Promise<void>;
  /** Reloads the page. */
  reload: () => void;
};

/**
 * Builds the switch over `save` and `reload`. Its members never reject: a failure is reported and answered `failed`.
 */
export function createWalletSwitch({ save, reload }: Params) {
  async function useLocalWallet(entropy: Uint8Array): Promise<WalletSwitchOutcome> {
    try {
      await save(entropy);
    } catch (error) {
      reportLocalWalletFailure(new Error('Local wallet could not be saved', { cause: error }), 'save');
      return 'failed';
    }
    report.log.event('local wallet saved');
    reload();
    return 'reloading';
  }

  async function usePolkadotApp(forget: () => Promise<void>): Promise<WalletSwitchOutcome> {
    try {
      await forget();
    } catch (error) {
      reportLocalWalletFailure(new Error('Local wallet could not be forgotten', { cause: error }), 'forget');
      return 'failed';
    }
    report.log.event('local wallet forgotten');
    reload();
    return 'reloading';
  }

  return {
    /** Uses this wallet in every app on the domain. Never rejects. */
    useLocalWallet,
    /**
     * Forgets the local wallet in every app on the domain through `forget`, so they sign with Polkadot App again. The
     * caller passes the forget, so it can forget only the record it read. Never rejects.
     */
    usePolkadotApp,
  };
}

/** This page's switch, which saves through the page's flag keeper and reloads the page. */
export const walletSwitch = createWalletSwitch({
  // Through the page's flag keeper, so a page that owns the flag raises it before the wallet lands in the main store,
  // and a framed preview leaves it alone.
  save: entropy => signInFlag.store(() => siteWallet.save(entropy, null)),
  reload: () => {
    window.location.reload();
  },
});
