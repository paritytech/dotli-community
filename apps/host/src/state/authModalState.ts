// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { isShallowEqual, registerStoreStateReset } from '@dotli/shared';
import { atom, type ReadableAtom } from 'nanostores';

/**
 * How far a pairing got: the code being made, the code to scan, the phone approving, or a failure. `error` carries the
 * raw failure `message` and the user-facing copy derived from it.
 */
export type PairingView =
  | { kind: 'spinner' }
  | { kind: 'pairing'; payload: string }
  | { kind: 'authenticating' }
  | {
      kind: 'error';
      message: string;
      retry: boolean;
      /** The account is still being set up, so the failure is a wait rather than a fault. */
      pending: boolean;
      title: string;
      subtitle: string;
      /** Raw reason for bug reports, absent when the copy hides it. */
      detail?: string | undefined;
    };

/**
 * What the sign-in modal shows: a pairing's view, or one of its own. `window` waits for the sign-in window, `blocked`
 * and `refused` say why it could not sign in, and `prompt` asks for the click a product's own login request cannot
 * give, worded to resume a sign-in made elsewhere when one waits. `phrase` takes a recovery phrase on a page that pairs
 * in place.
 */
export type AuthModalView =
  | PairingView
  | { kind: 'window' }
  | { kind: 'blocked' }
  | { kind: 'refused' }
  | { kind: 'prompt'; resume: boolean }
  | { kind: 'phrase' };

/**
 * `open` is true only while the modal holds the blocking-modal lease. `productLabel` has the TLD
 * applied, and is null for host-global login.
 */
export type AuthModalState = {
  open: boolean;
  productLabel: string | null;
  reason: string | null;
  view: AuthModalView;
};

const INITIAL: AuthModalState = {
  open: false,
  productLabel: null,
  reason: null,
  view: { kind: 'spinner' },
};

const authModal = atom<AuthModalState>(INITIAL);
authModal.eq = isSameAuthModal;
registerStoreStateReset(() => {
  authModal.set(INITIAL);
});
const store: ReadableAtom<AuthModalState> = authModal;

// The modal hydrates as an island of its own, so the control focus returns to is handed over here, not passed in.
let trigger: HTMLElement | undefined;

/** The sign-in modal's presentation, and the control focus returns to as it closes. */
export const authModalState = {
  /** What the modal shows. Notifies only when a field or the view changes. */
  store,
  /** Writes `patch` over the current state, keeping the fields it leaves out. Never throws. */
  update,
  /** Closes the modal and clears what it shows. Never throws. */
  reset,
  /** Returns the control focus returns to as the modal closes, or undefined when none is handed over. Never throws. */
  getTrigger,
  /**
   * Hands over the control focus returns to as the modal closes. Returns a release that clears it, unless another
   * control was handed over since. Never throws.
   */
  setTrigger,
};

registerStoreStateReset(() => {
  trigger = undefined;
});

function update(patch: Partial<AuthModalState>): void {
  authModal.set({ ...authModal.get(), ...patch });
}

function reset(): void {
  authModal.set(INITIAL);
}

function getTrigger(): HTMLElement | undefined {
  return trigger;
}

function setTrigger(element: HTMLElement): () => void {
  trigger = element;
  function releaseTrigger(): void {
    if (trigger === element) {
      trigger = undefined;
    }
  }
  return releaseTrigger;
}

/** The view is rebuilt per write, so it is compared one level deeper. */
function isSameAuthModal(previous: AuthModalState, next: AuthModalState): boolean {
  return (
    previous.open === next.open &&
    previous.productLabel === next.productLabel &&
    previous.reason === next.reason &&
    isShallowEqual(previous.view, next.view)
  );
}
