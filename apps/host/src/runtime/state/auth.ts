// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { DotliAuthState } from '../host-callbacks/AuthState.js';
import { createSyncStore, type ReadableStore } from '@dotli/shared';

// Every login step must reach the auth controller, including a repeated LoginFailed, so no set is dropped as equal.
const auth = createSyncStore<DotliAuthState>('auth', { tag: 'Restoring' }, { equals: () => false });
const session = createSyncStore<boolean>('session', false);

// Signed in from `Connected` until the session ends. The login steps in between leave it as it was, so a signed-in
// user who pairs again stays signed in. Subscribed here first, so every other auth listener sees the session already.
auth.subscribe(() => {
  const { tag } = auth.get();
  if (tag === 'Connected') {
    session.set(true);
  } else if (tag === 'Disconnected' || tag === 'Unreachable') {
    session.set(false);
  }
});

export const authStore: ReadableStore<DotliAuthState> = auth;
export const getAuthState = auth.get;

/** A login under way or done, so another one has nothing to do. */
export function isLoginActive(state: DotliAuthState): boolean {
  return state.tag === 'Pairing' || state.tag === 'Authenticating' || state.tag === 'Connected';
}

export function setAuthState(next: DotliAuthState): void {
  auth.set(next);
}

export const loggedInStore: ReadableStore<boolean> = session;
export const getLoggedIn = session.get;
