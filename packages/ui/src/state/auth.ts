// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { DotliAuthState } from "../host-callbacks/AuthState";
import { createSyncStore } from "./create-store";

const auth = createSyncStore<DotliAuthState>({ tag: "Disconnected" });
const session = createSyncStore<boolean>(false);

export const authState = auth.read;
export const getAuthState = auth.get;

/**
 * Also dispatches `dotli:truapi-auth-state` with the same detail as before:
 * the e2e global setup and the topbar and chat panel listen for it.
 */
export function setAuthState(next: DotliAuthState): void {
  auth.set(next);
  window.dispatchEvent(
    new CustomEvent<DotliAuthState>("dotli:truapi-auth-state", {
      detail: next,
    }),
  );
}

export const loggedIn = session.read;
export const getLoggedIn = session.get;

/** Also dispatches `dotli:authenticated` or `dotli:logged-out`, as the topbar did. */
export function setLoggedIn(next: boolean): void {
  session.set(next);
  window.dispatchEvent(
    new Event(next ? "dotli:authenticated" : "dotli:logged-out"),
  );
}
