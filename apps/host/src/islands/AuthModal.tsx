// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// One module per island, so Astro loads only this island's code when its directive fires.

import type { JSX } from '@solidjs/web';
import { authControl } from '../runtime/authControl.js';
import { LayerTracker, ModalFocusFallback, RootBoundary } from '@dotli/ui';
import { useStore } from '@dotli/stores-solid';
import { productFrameLayout } from '../createProductFrameLayout.js';
import { AuthModal as Modal, type AuthModalPlacement } from '../components/account/AuthModal.js';
import { authModalState } from '../state/authModalState.js';
import { topbarSurfaces } from '../state/topbarSurfaces.js';
import { pageTopbarAutoHide } from '../createTopbarAutoHide.js';
import { closeWhenOpen, useRevealWhileOpen } from './useRevealWhileOpen.js';

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
    <RootBoundary root="island:AuthModal" onBroken={authControl.disableModal}>
      <BoundModal placement={props.placement} />
    </RootBoundary>
  );
}

// Inside the boundary, so a store read that throws also disables the modal.
function BoundModal(props: { placement: AuthModalPlacement }): JSX.Element {
  const state = useStore(authModalState.store);
  useRevealWhileOpen(
    useStore(authModalState.store, modal => modal.open),
    pageTopbarAutoHide.reveal,
  );
  return (
    <LayerTracker value={topbarSurfaces.register}>
      <ModalFocusFallback value={productFrameLayout.getFocusFallback}>
        <Modal
          placement={props.placement}
          state={state}
          onClose={closeWhenOpen(authModalState.store, authControl.closeAuthModal)}
          onRetry={() => {
            authControl.retryLogin();
          }}
          onFocusWindow={() => {
            authControl.focusSignInWindow();
          }}
          restoreFocus={authModalState.getTrigger}
          isValidPhrase={authControl.isValidPhrase}
          onImportPhrase={authControl.importPhraseInPage}
        />
      </ModalFocusFallback>
    </LayerTracker>
  );
}
