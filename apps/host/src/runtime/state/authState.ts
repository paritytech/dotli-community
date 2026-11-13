// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createReporter } from '@dotli/metrics';
import { authViews } from '../session/authViews.js';
import type { DotliAuthState } from '../session/types.js';
import { createListenerSet, registerAtomReset } from '@dotli/shared';
import { atom, type ReadableAtom } from 'nanostores';

const report = createReporter({ flow: 'wallet' });

const auth = atom<DotliAuthState>({ tag: 'Restoring' });
registerAtomReset(auth);
const session = atom<boolean>(false);
registerAtomReset(session);
const store: ReadableAtom<DotliAuthState> = auth;
const loggedInStore: ReadableAtom<boolean> = session;
const steps = createListenerSet<DotliAuthState>({ onListenerError: report.listener('auth_state.step') });

/** The page's auth step, and whether the user is logged in. */
export const authState = {
  /** The current auth step. It notifies on a change. */
  store,
  /**
   * Publishes the next auth step to the store, which notifies on a change, then to every step listener, an equal step
   * included. Throws what a store listener threw, once every step listener heard the step.
   */
  set,
  /**
   * Hears every step set after it subscribed, an equal one included, in the order the steps were set. A step set from
   * inside a store listener that runs while an outer `set` still delivers, such as one of `store` or `loggedInStore`,
   * is heard before that outer step, since the outer step reaches the step listeners only once the store's listeners
   * ran. A step set from inside any store's listener round is heard at once, before the store's listeners run, so
   * `loggedInStore` may not have folded it yet. A listener that throws is reported, and the others still hear the
   * step. Returns the unsubscribe.
   */
  subscribeSteps: steps.subscribe,
  /**
   * Whether the user is logged in: from `Connected` until `Disconnected` or `Unreachable`. The login steps in between
   * leave it as it was, so a logged-in user who pairs again stays logged in. It already matches the step an auth `store`
   * listener hears.
   */
  loggedInStore,
};

/** The page's auth state object, as `authState` builds it. */
export type AuthState = typeof authState;

// Listening from import, before any other auth listener, so every other listener sees the session already.
auth.listen(followSession);

function set(next: DotliAuthState): void {
  // A store listener that throws must not keep the step from the step listeners.
  try {
    auth.set(next);
  } finally {
    steps.emit(next);
  }
}

function followSession(): void {
  const change = authViews.getLoggedInChange(auth.get());
  if (change !== null) {
    session.set(change);
  }
}
