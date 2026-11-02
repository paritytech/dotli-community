// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The account and sign-in state a story gives the views, and what the views asked of it. Plays move it the way the
// page's session does.

import { createSignal, flush } from 'solid-js';
import type { AccountSession } from '../../components/account/account.js';
import type { Account } from '../../components/account/account.js';

type AccountShape = {
  loggedIn: boolean;
  session: AccountSession | undefined;
  connected: boolean;
  restoring: boolean;
  unreachable: boolean;
  signingOut: boolean;
  local: boolean;
  elsewhere: boolean;
};

/** Boot has not read the saved session yet. */
const RESTORING: AccountShape = {
  loggedIn: false,
  session: undefined,
  connected: false,
  restoring: true,
  unreachable: false,
  signingOut: false,
  local: false,
  elsewhere: false,
};

const [shape, setShape] = createSignal<AccountShape>(RESTORING);
const [modalOpen, setModalOpenSignal] = createSignal(false);

// Each write is flushed, so the next one, and a play's read, builds on it.
function changeShape(change: Partial<AccountShape>): void {
  setShape({ ...shape(), ...change });
  flush();
}

export const storyAccount: Account = {
  loggedIn: () => shape().loggedIn,
  session: () => shape().session,
  connected: () => shape().connected,
  restoring: () => shape().restoring,
  unreachable: () => shape().unreachable,
  signingOut: () => shape().signingOut,
  local: () => shape().local,
  elsewhere: () => shape().elsewhere,
};

/** Whether the sign-in modal is open, as the account button reads it. */
export const storyModalOpen = modalOpen;

/** What the views asked for in this story. */
export const calls = { signIns: 0, logouts: 0 };

let trigger: HTMLElement | undefined;

/** The callbacks a page gives the views. A sign-in opens the modal as the page's controller would. */
export const storyCallbacks = {
  onSignIn: (): void => {
    calls.signIns += 1;
    setModalOpen(true);
  },
  onLogout: (): void => {
    calls.logouts += 1;
  },
  handOver: (el: HTMLElement): (() => void) => {
    trigger = el;
    return () => {
      if (trigger === el) {
        trigger = undefined;
      }
    };
  },
  restoreFocus: (): HTMLElement | undefined => trigger,
};

/** A connected session. */
export function connect(session: AccountSession): void {
  changeShape({ loggedIn: true, session, connected: true, restoring: false, unreachable: false, elsewhere: false });
}

/** Signed out, as boot leaves a visitor with no saved session. */
export function disconnect(): void {
  changeShape({
    loggedIn: false,
    session: undefined,
    connected: false,
    restoring: false,
    unreachable: false,
    elsewhere: false,
  });
}

/** Signed out here while a sign-in made elsewhere on the site waits, or no longer waits. */
export function signedInElsewhere(waits = true): void {
  changeShape({ elsewhere: waits });
}

/** A pairing or a login under way: no longer connected, a signed-in user's session kept. */
export function notConnected(): void {
  changeShape({ connected: false, restoring: false, unreachable: false });
}

/** The saved session cannot be reached. */
export function unreachable(): void {
  changeShape({ loggedIn: false, session: undefined, connected: false, restoring: false, unreachable: true });
}

/** A sign-out waiting for the sign-out window, the account still shown. */
export function signingOut(pending: boolean): void {
  changeShape({ signingOut: pending });
}

/** The keys live in this browser. */
export function localWallet(): void {
  changeShape({ local: true });
}

/** Opens or closes the sign-in modal, as the page's controller does. */
export function setModalOpen(open: boolean): void {
  setModalOpenSignal(open);
  flush();
}

/** For a story's `beforeEach`: back to a page whose session is still being read, with nothing asked. */
export function resetStoryAccount(): void {
  setShape(RESTORING);
  setModalOpen(false);
  calls.signIns = 0;
  calls.logouts = 0;
  trigger = undefined;
}
