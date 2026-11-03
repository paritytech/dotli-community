// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { DotliAuthState } from '../session/types.js';
import { registerStoreStateReset } from '@dotli/shared';
import { atom, type ReadableAtom } from 'nanostores';

const INITIAL_AUTH: DotliAuthState = { tag: 'Restoring' };
const INITIAL_SESSION = false;

const auth = atom<DotliAuthState>(INITIAL_AUTH);
// Every login step must notify, including a repeated LoginFailed, so no set is dropped as equal.
auth.eq = () => false;
registerStoreStateReset(() => {
  auth.set(INITIAL_AUTH);
});
const session = atom<boolean>(INITIAL_SESSION);
registerStoreStateReset(() => {
  session.set(INITIAL_SESSION);
});
const store: ReadableAtom<DotliAuthState> = auth;
const loggedInStore: ReadableAtom<boolean> = session;

/** The page's auth step, and whether the user is logged in. */
export const authState = {
  /** The current auth step. It notifies on every `set`, an equal step included. */
  store,
  /** Returns the current auth step. Never throws. */
  get,
  /** Publishes the next auth step and notifies every subscriber, even when it equals the current one. Never throws. */
  set,
  /**
   * Whether the user is logged in: from `Connected` until `Disconnected` or `Unreachable`. The login steps in between
   * leave it as it was, so a logged-in user who pairs again stays logged in. It already matches the step an auth
   * subscriber hears.
   */
  loggedInStore,
  /** Returns whether the user is logged in now. Never throws. */
  isLoggedIn,
};

// Subscribed at import, before any other auth listener, so every other listener sees the session already.
auth.listen(followSession);

function get(): DotliAuthState {
  return auth.get();
}

function set(next: DotliAuthState): void {
  auth.set(next);
}

function isLoggedIn(): boolean {
  return session.get();
}

function followSession(): void {
  const { tag } = auth.get();
  if (tag === 'Connected') {
    session.set(true);
  } else if (tag === 'Disconnected' || tag === 'Unreachable') {
    session.set(false);
  }
}
