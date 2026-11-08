// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A sign-in asked for while the saved sign-in cannot be read. The session is read again first, so it never starts over
// a session that may still be signed in.

import { log } from '@dotli/shared';
import type { ReadableAtom } from 'nanostores';
import type { AuthModalView } from '../state/authModalState.js';
import { authViews } from './session/authViews.js';
import type { DotliAuthState } from './session/types.js';
import type { AuthModalPort } from './signInRoute.js';

type Params = {
  /** Opens the auth modal for this sign-in and returns whether it is open. Never throws. */
  open: () => boolean;
  /** The auth modal's lease and view. */
  modal: Pick<AuthModalPort, 'getLease' | 'show'>;
  /** Reads the saved session again and settles once the page shows it. Rejects when the bridge chunk fails to load. */
  rereadSession: () => Promise<void>;
  /** The page's auth state, read once the re-read settled. */
  auth: ReadableAtom<DotliAuthState>;
  /** Goes on with the sign-in the click asked for, on a page that pairs in place, or null on a page with a window. */
  proceed: (() => void) | null;
  /** Whether a sign-in made elsewhere waits, which the window's prompt offers to resume. */
  elsewhere: () => boolean;
};

const UNREACHABLE_VIEW: AuthModalView = {
  kind: 'error',
  message: 'The saved session cannot be read',
  retry: true,
  pending: false,
  title: "Can't reach your saved sign-in",
  subtitle: 'dot.li could not check whether you are signed in. Try again in a moment.',
};

/** Reads the saved session again for a click made while it was unreachable, then goes on or explains. Never rejects. */
export async function rereadBeforeSignIn(params: Params): Promise<void> {
  const { open, modal, rereadSession, auth } = params;
  if (!open()) {
    return;
  }
  modal.show({ kind: 'spinner' });
  const lease = modal.getLease();
  try {
    await rereadSession();
  } catch (error) {
    log.error('[dot.li auth] saved session re-read failed:', error);
    // A modal closed meanwhile stays closed.
    if (modal.getLease() === lease) {
      modal.show(UNREACHABLE_VIEW);
    }
    return;
  }
  if (modal.getLease() !== lease) {
    return;
  }
  continueAfterReread(auth.get(), params);
}

function continueAfterReread(state: DotliAuthState, { modal, proceed, elsewhere }: Params): void {
  switch (authViews.getSessionKnowledge(state)) {
    case 'unreachable':
      modal.show(UNREACHABLE_VIEW);
      return;
    case 'reading':
      // A read is under way, so the click starts nothing.
      return;
    case 'known':
      break;
  }
  // A sign-in is under way, or the user is signed in, so the click starts nothing.
  if (!authViews.isSignInIdle(state)) {
    return;
  }
  if (proceed !== null) {
    proceed();
    return;
  }
  modal.show({ kind: 'prompt', resume: elsewhere() });
}
