// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  authState,
  getAuthState,
  getLoggedIn,
  loggedIn,
  setAuthState,
  setLoggedIn,
} from "@dotli/ui/state/auth";
import { dispatchAuthState } from "@dotli/ui/host-callbacks/AuthState";
import { resetStores, settle } from "../helpers/solid";

describe("auth store", () => {
  afterEach(() => {
    resetStores();
  });

  it("As the topbar, the auth store starts Disconnected and logged out", () => {
    // Then
    expect(getAuthState()).toEqual({ tag: "Disconnected" });
    expect(getLoggedIn()).toBe(false);
  });

  it("As a listener of dotli:truapi-auth-state, the event carries the same detail and the store already holds it", async () => {
    // Given
    const seen: { detail: unknown; storeTag: string }[] = [];
    const listener = (e: Event): void => {
      seen.push({
        detail: (e as CustomEvent).detail,
        storeTag: getAuthState().tag,
      });
    };
    window.addEventListener("dotli:truapi-auth-state", listener);

    // When
    setAuthState({ tag: "Authenticating" });
    await settle();

    // Then
    expect(seen).toEqual([
      { detail: { tag: "Authenticating" }, storeTag: "Authenticating" },
    ]);
    expect(authState()).toEqual({ tag: "Authenticating" });
    window.removeEventListener("dotli:truapi-auth-state", listener);
  });

  it("As the TrUAPI host callback, dispatchAuthState writes through the store", () => {
    // When
    dispatchAuthState({ tag: "Authenticating" });

    // Then
    expect(getAuthState()).toEqual({ tag: "Authenticating" });
  });

  it("As a listener, setLoggedIn fires dotli:authenticated and dotli:logged-out exactly as before", async () => {
    // Given
    const events: string[] = [];
    const onAuth = vi.fn(() => events.push("authenticated"));
    const onOut = vi.fn(() => events.push("logged-out"));
    window.addEventListener("dotli:authenticated", onAuth);
    window.addEventListener("dotli:logged-out", onOut);

    // When
    setLoggedIn(true);
    setLoggedIn(false);
    await settle();

    // Then
    expect(events).toEqual(["authenticated", "logged-out"]);
    expect(loggedIn()).toBe(false);
    window.removeEventListener("dotli:authenticated", onAuth);
    window.removeEventListener("dotli:logged-out", onOut);
  });
});
