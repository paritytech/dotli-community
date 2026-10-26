// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The sign-in route of a page with no sign-in window. It pairs in place on the core, in the bridge chunk, and takes a
// recovery phrase in the modal.

import { errorMessage } from '@dotli/shared';
import { reportLazyMiss } from '../lazy-miss.js';
import type { AuthModalPort, SignInRoute } from './sign-in-route.js';
import { reportLocalWalletFailure } from './wallet-failure.js';
import type { WalletSwitchOutcome } from './wallet-switch.js';

/** The recovery phrase import of a page that pairs in place. */
export interface InPagePhrase {
  /** The phrase's entropy, or null for anything that is not a recovery phrase. */
  toEntropy(phrase: string): Uint8Array | null;
  /** Uses the wallet in every app on the domain and reloads. A failure is reported there and answered as `failed`. */
  useLocalWallet(entropy: Uint8Array): Promise<WalletSwitchOutcome>;
}

export interface InPageSignInDeps {
  /** Loaded the first time the page asks for a phrase, so a page that never asks loads none of it. */
  inPagePhrase: () => Promise<InPagePhrase>;
  modal: AuthModalPort;
  /** Asks the core to log in. */
  login: (reason?: string) => void;
}

export function createInPageSignIn(deps: InPageSignInDeps): SignInRoute {
  const { modal } = deps;
  // The phrase import, once loaded for the modal's phrase view, which shows only after it.
  let inPagePhrase: InPagePhrase | null = null;
  // Whether Retry imports the phrase again, because a phrase view that failed to load is on show and no pairing.
  let retryImportsPhrase = false;

  function openPhraseView(): void {
    if (!modal.open()) {
      return;
    }
    const scope = modal.lease();
    void deps.inPagePhrase().then(
      loaded => {
        inPagePhrase = loaded;
        // A modal closed meanwhile stays closed.
        if (modal.lease() === scope) {
          retryImportsPhrase = false;
          modal.show({ kind: 'phrase' });
        }
      },
      (error: unknown) => {
        reportLazyMiss('wallet', 'phrase_import', error);
        if (modal.lease() === scope) {
          retryImportsPhrase = true;
          modal.showFailure('Other', errorMessage(error));
        }
      },
    );
  }

  return {
    startLogin(reason, label) {
      // The modal already shows that login, and a reset would swap its QR for a spinner that never resolves. An error
      // shows none, so its Retry logs in again.
      if (modal.lease() !== null && modal.viewKind() !== 'error') {
        return;
      }
      if (modal.open(reason, label)) {
        deps.login(reason);
      }
    },
    importPhrase() {
      openPhraseView();
    },
    retriesPhrase() {
      return retryImportsPhrase;
    },
    pairing(state) {
      modal.open(undefined, state.hostGlobal === true ? undefined : state.label, { dotSuffix: state.dotSuffix });
      if (state.deeplink) {
        modal.show({ kind: 'pairing', payload: state.deeplink });
      }
    },
    waiting() {
      return false;
    },
    signOut() {
      // A page with no sign-in window has no sign-out window to open.
    },
    focus() {
      // A page with no sign-in window has nothing to bring forward.
    },
    end() {
      retryImportsPhrase = false;
    },
    isValidPhrase(phrase) {
      return (inPagePhrase?.toEntropy(phrase) ?? null) !== null;
    },
    async importPhraseInPage(phrase) {
      const loaded = inPagePhrase;
      if (loaded === null) {
        // The phrase view shows only once the module loaded, so this is a fault of the page and not of the input.
        const error = new Error('The recovery phrase import was not loaded');
        reportLocalWalletFailure(error, 'phrase-load');
        throw error;
      }
      const entropy = loaded.toEntropy(phrase);
      if (entropy === null) {
        throw new Error('Not a valid recovery phrase');
      }
      if ((await loaded.useLocalWallet(entropy)) === 'failed') {
        throw new Error('The recovery phrase wallet could not be saved');
      }
    },
  };
}
