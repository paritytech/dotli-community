// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// One module per island, so Astro loads only this island's code when its directive fires.

import type { JSX } from '@solidjs/web';
import {
  closeAuthModal,
  disableAuthModal,
  focusSignInWindow,
  importPhraseInPage,
  isValidPhrase,
  retryLogin,
} from '../runtime/auth-controller.js';
import { LayerTracker, ModalFocusFallback, RootBoundary, useStore } from '@dotli/ui';
import { productFrameFocus } from '../product-frame-layout.js';
import { AuthModal as Modal, type AuthModalPlacement } from '../components/account/AuthModal.js';
import { authModalStore, getAuthModalTrigger } from '../state/auth-modal.js';
import { registerTopbarSurface } from '../state/topbar-surfaces.js';
import { revealTopbar } from '../topbar-autohide.js';
import { closeWhenOpen, useRevealWhileOpen } from './auth-modal.js';

/**
 * The sign-in modal, bound to the state the auth controller writes from boot, so a sign-in started before hydration
 * shows once hydrated.
 *
 * Closing cancels the login. The controller opens it only once it holds the blocking-modal lease, so it never closes
 * for another blocking modal, and a sign-in queued behind one reveals nothing until then. A modal that breaks is
 * disabled, so a sign-in never holds the blocking-modal lease for a modal nobody can see.
 *
 * The page says where the modal stands, as only it knows whether it has a topbar.
 */
export function AuthModal(props: { placement: AuthModalPlacement }): JSX.Element {
  return (
    <RootBoundary root="island:AuthModal" onBroken={disableAuthModal}>
      <BoundModal placement={props.placement} />
    </RootBoundary>
  );
}

// Inside the boundary, so a store read that throws also disables the modal.
function BoundModal(props: { placement: AuthModalPlacement }): JSX.Element {
  const state = useStore(authModalStore);
  useRevealWhileOpen(
    useStore(authModalStore, modal => modal.open),
    revealTopbar,
  );
  return (
    <LayerTracker value={registerTopbarSurface}>
      <ModalFocusFallback value={productFrameFocus}>
        <Modal
          placement={props.placement}
          state={state}
          onClose={closeWhenOpen(authModalStore, closeAuthModal)}
          onRetry={() => {
            retryLogin();
          }}
          onFocusWindow={() => {
            focusSignInWindow();
          }}
          restoreFocus={getAuthModalTrigger}
          isValidPhrase={isValidPhrase}
          onImportPhrase={importPhraseInPage}
        />
      </ModalFocusFallback>
    </LayerTracker>
  );
}
