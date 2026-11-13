// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The slot of the page's auth controller, for islands that hydrate on their own and so cannot be handed one.

import { registerStoreStateReset } from '@dotli/shared';
import { createAuthController, type AuthController } from './createAuthController.js';
import type { CloseAuthModalParams } from './signInRoute.js';
import { authState } from './state/authState.js';
import { sessionElsewhereState } from './state/sessionElsewhereState.js';
import { walletModeState } from './state/walletModeState.js';

/** What the slot's `init` takes: the controller's params, less the page stores the slot reads itself. */
type InitParams = Omit<
  Parameters<typeof createAuthController>[0],
  'auth' | 'subscribeAuthSteps' | 'isLocalWallet' | 'elsewhere'
>;

/**
 * Builds the slot that holds a page's auth controller, which every member but `init` and `disableModal` needs. A store
 * reset disposes the controller and empties the slot.
 */
export function createAuthControlSlot() {
  let controller: AuthController | null = null;
  // An island can fail to hydrate before boot starts the controller.
  let modalBroken = false;

  registerStoreStateReset(() => {
    controller?.dispose();
    controller = null;
    modalBroken = false;
  });

  function requireController(): AuthController {
    if (controller === null) {
      throw new Error('Auth control used before init');
    }
    return controller;
  }

  function init(params: InitParams): AuthController {
    controller?.dispose();
    const started = createAuthController({
      ...params,
      auth: authState.store,
      subscribeAuthSteps: authState.subscribeSteps,
      isLocalWallet: walletModeState.isLocal,
      elsewhere: () => sessionElsewhereState.store.get(),
    });
    if (modalBroken) {
      started.disableAuthModal();
    }
    controller = started;
    return started;
  }

  function startLogin(): void {
    requireController().startLogin();
  }

  function retryLogin(): void {
    requireController().retryLogin();
  }

  function importPhrase(): void {
    requireController().importPhrase();
  }

  function isValidPhrase(phrase: string): boolean {
    return requireController().isValidPhrase(phrase);
  }

  function importPhraseInPage(phrase: string): Promise<void> {
    return requireController().importPhraseInPage(phrase);
  }

  function logout(): void {
    requireController().logout();
  }

  function focusSignInWindow(): void {
    requireController().focusSignInWindow();
  }

  function closeAuthModal(params: CloseAuthModalParams = {}): void {
    requireController().closeAuthModal(params);
  }

  function disableModal(): void {
    modalBroken = true;
    controller?.disableAuthModal();
  }

  return {
    /**
     * Starts the controller over the page's stores, disposing the one started before, and returns it. A modal disabled
     * before stays disabled.
     */
    init,
    /** Starts a sign-in with no reason or label. Throws before `init`. */
    startLogin,
    /** The modal's Retry, Try again and Sign in. Throws before `init`. */
    retryLogin,
    /** Asks for a recovery phrase. Throws before `init`. */
    importPhrase,
    /** Whether the modal's phrase view takes `phrase`. Throws before `init`. */
    isValidPhrase,
    /**
     * Uses the wallet of a phrase the modal's phrase view took. Throws before `init`. Rejects when the wallet could not
     * be saved, when the phrase import has not loaded, or when the phrase is not valid.
     */
    importPhraseInPage,
    /** Opens the sign-out window, then logs out. Throws before `init`. */
    logout,
    /** Brings the sign-in window of the open round to the front. Throws before `init`. */
    focusSignInWindow,
    /** Closes the modal, cancelling the login it showed unless `params` says not to. Throws before `init`. */
    closeAuthModal,
    /**
     * For when the auth-modal island failed. Disables the modal now and for every controller `init` starts later, and
     * works before `init`.
     */
    disableModal,
  };
}

/** The page's auth controller, for islands that hydrate on their own and so cannot be handed one. */
export const authControl = createAuthControlSlot();
