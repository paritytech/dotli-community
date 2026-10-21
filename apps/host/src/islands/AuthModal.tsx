// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// One module per island, so Astro loads only this island's code when its directive fires.

import type { JSX } from '@solidjs/web';
import { closeAuthModal, disableAuthModal, retryLogin } from '../runtime/auth-controller.js';
import { LayerTracker, ModalFocusFallback, RootBoundary, useStore } from '@dotli/ui';
import { productFrameFocus } from '../product-frame-layout.js';
import { AuthModal as Modal } from '../components/account/AuthModal.js';
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
 */
export function AuthModal(): JSX.Element {
  return (
    <RootBoundary root="island:AuthModal" onBroken={disableAuthModal}>
      <BoundModal />
    </RootBoundary>
  );
}

// Inside the boundary, so a store read that throws also disables the modal.
function BoundModal(): JSX.Element {
  const state = useStore(authModalStore);
  useRevealWhileOpen(
    useStore(authModalStore, modal => modal.open),
    revealTopbar,
  );
  return (
    <LayerTracker value={registerTopbarSurface}>
      <ModalFocusFallback value={productFrameFocus}>
        <Modal
          state={state}
          onClose={closeWhenOpen(authModalStore, closeAuthModal)}
          onRetry={() => {
            retryLogin();
          }}
          restoreFocus={getAuthModalTrigger}
        />
      </ModalFocusFallback>
    </LayerTracker>
  );
}
