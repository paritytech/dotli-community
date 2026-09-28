// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { DotliAuthState } from "../host-callbacks/AuthState";
import {
  createSyncStore,
  shallowEqual,
  type ReadableStore,
} from "./create-store";

// Equal states notify nobody; setAuthState still dispatches its event.
const auth = createSyncStore<DotliAuthState>(
  { tag: "Disconnected" },
  { equals: shallowEqual },
);
const session = createSyncStore<boolean>(false);

export const authStore: ReadableStore<DotliAuthState> = auth;
export const getAuthState = auth.get;

/**
 * Also dispatches `dotli:truapi-auth-state` with the same detail as before:
 * the auth controller, the chat panel and the e2e global setup listen for it.
 */
export function setAuthState(next: DotliAuthState): void {
  auth.set(next);
  window.dispatchEvent(
    new CustomEvent<DotliAuthState>("dotli:truapi-auth-state", {
      detail: next,
    }),
  );
}

export const loggedInStore: ReadableStore<boolean> = session;
export const getLoggedIn = session.get;

/** Also dispatches `dotli:authenticated` or `dotli:logged-out`, as the topbar did. */
export function setLoggedIn(next: boolean): void {
  session.set(next);
  window.dispatchEvent(
    new Event(next ? "dotli:authenticated" : "dotli:logged-out"),
  );
}
