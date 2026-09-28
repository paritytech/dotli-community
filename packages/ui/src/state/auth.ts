// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { DotliAuthState } from "../host-callbacks/AuthState";
import { createSyncStore, type ReadableStore } from "./create-store";

// Every state notifies, an equal one too: each is a step of the core's login
// flow that the auth controller acts on (a second identical LoginFailed after
// a retry must show its error again).
const auth = createSyncStore<DotliAuthState>({ tag: "Disconnected" });
const session = createSyncStore<boolean>(false);

export const authStore: ReadableStore<DotliAuthState> = auth;
export const getAuthState = auth.get;

/**
 * Notifies the store's listeners (the auth controller first: it subscribes at
 * boot), then dispatches `dotli:truapi-auth-state` with the state as detail,
 * for the e2e global setup.
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
