// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Every switch reloads, so the core boots in the new mode instead of being swapped while it runs. A failed switch is
// reported here and leaves the page as it was, so callers only show it.

import { SITE_ID } from '@dotli/config';
import { forgetSharedLocalWallet, saveSharedLocalWallet } from '@dotli/protocol';
import { log } from '@dotli/shared';
import { reportLocalWalletFailure } from './wallet-boot.js';

/** `reloading` once the switch is stored for every app, `failed` after the failure was reported. */
export type WalletSwitchOutcome = 'reloading' | 'failed';

export interface WalletSwitch {
  /** Uses this wallet in every app on the domain. */
  useLocalWallet(entropy: Uint8Array): Promise<WalletSwitchOutcome>;
  /** Forgets the local wallet in every app on the domain, so they sign with Polkadot App again. */
  usePolkadotApp(): Promise<WalletSwitchOutcome>;
}

export interface WalletSwitchDeps {
  save: (entropy: Uint8Array) => Promise<void>;
  forget: () => Promise<void>;
  reload: () => void;
}

export function createWalletSwitch({ save, forget, reload }: WalletSwitchDeps): WalletSwitch {
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
    async usePolkadotApp() {
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
  save: entropy => saveSharedLocalWallet(SITE_ID, entropy),
  forget: () => forgetSharedLocalWallet(SITE_ID),
  reload: () => {
    window.location.reload();
  },
});
