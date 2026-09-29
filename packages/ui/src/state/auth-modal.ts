// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSyncStore, shallowEqual, type ReadableStore } from './create-store.js';

/**
 * What the modal body shows. `error` carries the raw failure `message` plus
 * the user-facing copy derived from it, and whether a retry can help.
 */
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
      /** Raw reason kept for bug reports; absent when the copy hides it. */
      detail?: string | undefined;
    };

/**
 * The QR pairing modal. `open` is true only while the modal holds the
 * blocking-modal lease; `productLabel` is the display label (TLD already
 * applied), null for host-global login.
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

/** Shallow, with the view compared one level deeper: it is rebuilt per write. */
function sameAuthModal(a: AuthModalState, b: AuthModalState): boolean {
  return (
    a.open === b.open && a.productLabel === b.productLabel && a.reason === b.reason && shallowEqual(a.view, b.view)
  );
}

const authModal = createSyncStore<AuthModalState>(INITIAL, {
  equals: sameAuthModal,
});

export const authModalStore: ReadableStore<AuthModalState> = authModal;
export const getAuthModalState = authModal.get;

// Written only by auth-controller.ts.

/** Replace the given fields, keeping the rest. */
export function updateAuthModal(patch: Partial<AuthModalState>): void {
  authModal.set({ ...authModal.get(), ...patch });
}

/** Closed, with nothing presented. */
export function resetAuthModal(): void {
  authModal.set(INITIAL);
}
