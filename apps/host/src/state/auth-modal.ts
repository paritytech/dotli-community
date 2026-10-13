// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSyncStore, shallowEqual, type ReadableStore } from '@dotli/shared';
import type { AuthModalState } from '@dotli/host-runtime';

const INITIAL: AuthModalState = {
  open: false,
  productLabel: null,
  reason: null,
  view: { kind: 'spinner' },
};

/** The view is rebuilt per write, so it is compared one level deeper. */
function sameAuthModal(a: AuthModalState, b: AuthModalState): boolean {
  return (
    a.open === b.open && a.productLabel === b.productLabel && a.reason === b.reason && shallowEqual(a.view, b.view)
  );
}

const authModal = createSyncStore<AuthModalState>('auth_modal', INITIAL, {
  equals: sameAuthModal,
});

export const authModalStore: ReadableStore<AuthModalState> = authModal;

// Written only by the runtime's auth controller, through the `AuthModalPort` startup passes it.

export function updateAuthModal(patch: Partial<AuthModalState>): void {
  authModal.set({ ...authModal.get(), ...patch });
}

export function resetAuthModal(): void {
  authModal.set(INITIAL);
}

// The account button gets focus back as the modal closes. They are separate islands, so the button
// hands itself over here.
let trigger: HTMLElement | undefined;

export function getAuthModalTrigger(): HTMLElement | undefined {
  return trigger;
}

export function setAuthModalTrigger(el: HTMLElement): () => void {
  trigger = el;
  return () => {
    if (trigger === el) {
      trigger = undefined;
    }
  };
}
