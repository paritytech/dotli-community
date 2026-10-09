// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSyncStore, shallowEqual, type ReadableStore } from './create-store.js';

/** `error` carries the raw failure `message` and the user-facing copy derived from it. */
export type AuthModalView =
  | { kind: 'spinner' }
  | { kind: 'pairing'; payload: string }
  | { kind: 'authenticating' }
  | {
      kind: 'error';
      message: string;
      retry: boolean;
      title: string;
      subtitle: string;
      /** Raw reason for bug reports, absent when the copy hides it. */
      detail?: string | undefined;
    };

/**
 * `open` is true only while the modal holds the blocking-modal lease. `productLabel` has the TLD
 * applied, and is null for host-global login.
 */
export interface AuthModalState {
  open: boolean;
  productLabel: string | null;
  reason: string | null;
  view: AuthModalView;
}

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
export const getAuthModalState = authModal.get;

// Written only by auth-controller.ts.

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
