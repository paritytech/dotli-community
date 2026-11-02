// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { DotliAuthState } from '../session/types.js';
import { createSyncStore, type ReadableStore } from '@dotli/shared';

// Every login step must notify, including a repeated LoginFailed, so no set is dropped as equal.
const auth = createSyncStore<DotliAuthState>({ name: 'auth', initial: { tag: 'Restoring' }, equals: () => false });
const session = createSyncStore<boolean>({ name: 'session', initial: false });
const store: ReadableStore<DotliAuthState> = auth;
const loggedInStore: ReadableStore<boolean> = session;

/** The page's auth step, and whether the user is logged in. */
export const authState = {
  /** The current auth step. It notifies on every `set`, an equal step included. */
  store,
  /** Returns the current auth step. Never throws. */
  get: auth.get,
  /** Publishes the next auth step and notifies every subscriber, even when it equals the current one. Never throws. */
  set: auth.set,
  /**
   * Whether the user is logged in: from `Connected` until `Disconnected` or `Unreachable`. The login steps in between
   * leave it as it was, so a logged-in user who pairs again stays logged in. It already matches the step an auth
   * subscriber hears.
   */
  loggedInStore,
  /** Returns whether the user is logged in now. Never throws. */
  isLoggedIn: session.get,
};

// Subscribed at import, before any other auth listener, so every other listener sees the session already.
auth.subscribe(followSession);

function followSession(): void {
  const { tag } = auth.get();
  if (tag === 'Connected') {
    session.set(true);
  } else if (tag === 'Disconnected' || tag === 'Unreachable') {
    session.set(false);
  }
}
