// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The sign-in modal's state a story gives the modal and the account button, and what the modal asked of it. Plays move
// it the way the page's auth controller does.

import { createSignal, flush } from 'solid-js';
import type { AuthModalState } from '../../state/auth-modal.js';

export const CLOSED_MODAL: AuthModalState = {
  open: false,
  productLabel: null,
  reason: null,
  view: { kind: 'spinner' },
};

const [modal, setModalSignal] = createSignal<AuthModalState>(CLOSED_MODAL);

// Each write is flushed, so the next one, and a play's read, builds on it.
function setModal(next: AuthModalState): void {
  setModalSignal(next);
  flush();
}

/** The sign-in modal's state as the views read it. */
export const storyModal = modal;

/** What the modal asked for in this story. */
export const modalCalls = { closes: 0, retries: 0 };

/**
 * The callbacks a page gives the modal and the sign-in it opens. They move the modal as the page's controller would.
 */
export const modalCallbacks = {
  onSignIn: (): void => {
    setModal({ ...CLOSED_MODAL, open: true });
  },
  onClose: (): void => {
    modalCalls.closes += 1;
    setModal(CLOSED_MODAL);
  },
  onRetry: (): void => {
    modalCalls.retries += 1;
    setModal({ ...modal(), view: { kind: 'spinner' } });
  },
};

/** Moves the sign-in modal, as the page's controller does. */
export function showModal(next: Partial<AuthModalState>): void {
  setModal({ ...modal(), ...next });
}

/** For a story's `beforeEach`: the modal closed, with nothing asked. */
export function resetStoryModal(): void {
  setModal(CLOSED_MODAL);
  modalCalls.closes = 0;
  modalCalls.retries = 0;
}
