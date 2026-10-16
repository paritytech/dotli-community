// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { DotliAuthState } from '../host-callbacks/AuthState.js';
import { createSyncStore, type ReadableStore } from './create-store.js';

// Every login step must reach the auth controller, including a repeated LoginFailed, so no set is dropped as equal.
const auth = createSyncStore<DotliAuthState>('auth', { tag: 'Restoring' }, { equals: () => false });
const session = createSyncStore<boolean>('session', false);

export const authStore: ReadableStore<DotliAuthState> = auth;
export const getAuthState = auth.get;

/** Listeners see the state before `dotli:truapi-auth-state`, which the e2e global setup reads. */
export function setAuthState(next: DotliAuthState): void {
  auth.set(next);
  window.dispatchEvent(
    new CustomEvent<DotliAuthState>('dotli:truapi-auth-state', {
      detail: next,
    }),
  );
}

export const loggedInStore: ReadableStore<boolean> = session;
export const getLoggedIn = session.get;

export function setLoggedIn(next: boolean): void {
  session.set(next);
  window.dispatchEvent(new Event(next ? 'dotli:authenticated' : 'dotli:logged-out'));
}
