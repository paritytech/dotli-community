// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from "vitest";
import { AuthButton } from "@dotli/ui/components/shell/AuthButton";
import { getAuthModalState } from "@dotli/ui/state/auth-modal";
import { authStore, setAuthState } from "@dotli/ui/state/auth";
import type { DotliAuthState } from "@dotli/ui/host-callbacks/AuthState";
import { renderComponent } from "../../helpers/solid";
import {
  byId,
  recordEvents,
  settleAll,
  useAuthController,
} from "./auth-harness";
import { normalized, oldAuthButton } from "./old-auth-markup";

useAuthController();

const PUBLIC_KEY =
  "0x000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

async function renderButton(): Promise<HTMLButtonElement> {
  renderComponent(() => <AuthButton />);
  await settleAll();
  return byId("auth-button", HTMLButtonElement);
}

/**
 * The button as topbar.ts left it, plus the ARIA of a Radix-style trigger
 * for what a click opens: logged in, the user popover; logged out, the
 * auth modal (a Radix Dialog.Trigger).
 */
function expectMarkup(button: Element, expected: Element): void {
  const account = expected.getAttribute("aria-label") === "Account";
  expected.setAttribute("aria-haspopup", "dialog");
  expected.setAttribute(
    "aria-expanded",
    !account && getAuthModalState().open ? "true" : "false",
  );
  expected.setAttribute(
    "aria-controls",
    account ? "user-popover" : "auth-modal-backdrop",
  );
  expect(normalized(button).isEqualNode(normalized(expected))).toBe(true);
}

describe("AuthButton", () => {
  it("As a dotli user, the button follows the auth store through one subscription", async () => {
    // Given
    const subscribe = vi.spyOn(authStore, "subscribe");

    // When
    await renderButton();

    // Then
    expect(subscribe).toHaveBeenCalledTimes(1);
    subscribe.mockRestore();
  });

  it("As a logged-out user, I see the login button, enabled, with the markup the topbar rendered", async () => {
    // When
    const button = await renderButton();

    // Then
    expect(button.title).toBe("Login with Polkadot Mobile");
    expect(button.getAttribute("aria-label")).toBe(
      "Login with Polkadot Mobile",
    );
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(button.hasAttribute("aria-busy")).toBe(false);
    expect(button.querySelector(".user-badge")).toBeNull();
    expectMarkup(button, oldAuthButton("logged-out"));
  });

  it("As a logged-in user, I see my initials in the badge, with the markup the topbar rendered", async () => {
    // Given
    const button = await renderButton();

    // When
    setAuthState({
      tag: "Connected",
      session: {
        connected: true,
        publicKey: PUBLIC_KEY,
        liteUsername: "pgherveou.04",
        primaryUsername: "pgherveou.04",
      },
    });
    await settleAll();

    // Then
    expect(button.textContent).toBe("PG");
    expect(button.title).toBe("Account");
    expectMarkup(button, oldAuthButton({ initials: "PG" }));
  });

  it("As a logged-in user with a full name, my badge shows the initials of my first two names", async () => {
    // Given
    const button = await renderButton();

    // When
    setAuthState({
      tag: "Connected",
      session: { connected: true, fullUsername: "ada  lovelace king" },
    });
    await settleAll();

    // Then
    expectMarkup(button, oldAuthButton({ initials: "AL" }));
  });

  it("As a logged-in user without a username, I see the anonymous badge, with the markup the topbar rendered", async () => {
    // Given
    const button = await renderButton();

    // When
    setAuthState({
      tag: "Connected",
      session: { connected: true, publicKey: PUBLIC_KEY },
    });
    await settleAll();

    // Then
    const badge = button.querySelector(".user-badge");
    expect(badge?.classList.contains("user-badge-anon")).toBe(true);
    expect(badge?.querySelector("svg")).not.toBeNull();
    expectMarkup(button, oldAuthButton({ initials: undefined }));
  });

  it("As a logged-in user whose name contains markup, my badge shows it as text", async () => {
    // Given
    const button = await renderButton();

    // When
    setAuthState({
      tag: "Connected",
      session: { connected: true, fullUsername: "<b>x</b>" },
    });
    await settleAll();

    // Then
    expect(button.querySelector("b")).toBeNull();
    expect(button.querySelector(".user-badge")?.textContent).toBe("<B");
    expectMarkup(button, oldAuthButton({ initials: "<B" }));
  });

  it("As a returning user whose session was restored before the islands loaded, the button shows my badge as it mounts", async () => {
    // Given: the boot rehydration ran before the chunk arrived.
    setAuthState({
      tag: "Connected",
      session: { connected: true, liteUsername: "pgherveou.04" },
    });

    // When
    const button = await renderButton();

    // Then
    expect(button.textContent).toBe("PG");
    expect(button.title).toBe("Account");
  });

  it("As a logged-in user, a pairing that starts elsewhere keeps my badge, and a disconnect brings the login button back", async () => {
    // Given
    const button = await renderButton();
    setAuthState({
      tag: "Connected",
      session: { connected: true, liteUsername: "pgherveou.04" },
    });
    await settleAll();

    // When
    setAuthState({
      tag: "Pairing",
      deeplink: "polkadotapp://pair?handshake=test",
      label: "app",
    });
    await settleAll();

    // Then: only Connected and Disconnected change the button.
    expect(button.textContent).toBe("PG");

    // When
    setAuthState({ tag: "Disconnected" });
    await settleAll();

    // Then
    expectMarkup(button, oldAuthButton("logged-out"));
  });

  it("As a logged-out screen-reader user, the button announces the auth modal a click opens, and whether it is open", async () => {
    // Given
    const button = await renderButton();
    const popupAria = (): (string | null)[] =>
      ["aria-haspopup", "aria-expanded", "aria-controls"].map((name) =>
        button.getAttribute(name),
      );

    // Then
    expect(popupAria()).toEqual(["dialog", "false", "auth-modal-backdrop"]);

    // When
    button.click();
    await settleAll();

    // Then
    expect(getAuthModalState().open).toBe(true);
    expect(popupAria()).toEqual(["dialog", "true", "auth-modal-backdrop"]);
  });

  it.each<[string, DotliAuthState]>([
    ["Disconnected", { tag: "Disconnected" }],
    [
      "Pairing",
      {
        tag: "Pairing",
        deeplink: "polkadotapp://pair?handshake=test",
        label: "app",
      },
    ],
    ["Authenticating", { tag: "Authenticating" }],
    [
      "LoginFailed",
      { tag: "LoginFailed", kind: "Other", reason: "Host failure" },
    ],
  ])(
    "As a screen-reader user, while the auth state is %s the button announces the auth modal, as a click starts a login",
    async (_tag, state) => {
      // Given
      const button = await renderButton();

      // When
      setAuthState(state);
      await settleAll();

      // Then
      expect(button.getAttribute("aria-haspopup")).toBe("dialog");
      expect(button.getAttribute("aria-controls")).toBe("auth-modal-backdrop");
      expect(button.getAttribute("aria-expanded")).toBe(
        getAuthModalState().open ? "true" : "false",
      );
    },
  );

  it("As a logged-in screen-reader user, the button announces the user popover only while connected, when a click opens it", async () => {
    // Given
    const button = await renderButton();
    const popupAria = (): (string | null)[] =>
      ["aria-haspopup", "aria-expanded", "aria-controls"].map((name) =>
        button.getAttribute(name),
      );
    setAuthState({
      tag: "Connected",
      session: { connected: true, liteUsername: "pgherveou.04" },
    });
    await settleAll();

    // Then
    expect(popupAria()).toEqual(["dialog", "false", "user-popover"]);

    // When: a pairing starts while logged in, so a click starts a login.
    setAuthState({
      tag: "Pairing",
      deeplink: "polkadotapp://pair?handshake=test",
      label: "app",
    });
    await settleAll();

    // Then: still showing the badge, but announcing the auth modal, which
    // the pairing opened.
    expect(button.textContent).toBe("PG");
    expect(getAuthModalState().open).toBe(true);
    expect(popupAria()).toEqual(["dialog", "true", "auth-modal-backdrop"]);

    // When
    setAuthState({ tag: "Authenticating" });
    await settleAll();

    // Then
    expect(popupAria()).toEqual([
      "dialog",
      getAuthModalState().open ? "true" : "false",
      "auth-modal-backdrop",
    ]);

    // When
    setAuthState({
      tag: "Connected",
      session: { connected: true, liteUsername: "pgherveou.04" },
    });
    await settleAll();

    // Then
    expect(popupAria()).toEqual(["dialog", "false", "user-popover"]);
  });

  it("As a logged-out user, clicking the button requests a login and opens the pairing modal", async () => {
    // Given
    const loginRequests = recordEvents("dotli:truapi-login-request");
    const button = await renderButton();

    // When
    button.click();
    await settleAll();

    // Then
    expect(loginRequests.details).toEqual([{ reason: undefined }]);
    expect(getAuthModalState().open).toBe(true);
    expect(getAuthModalState().productLabel).toBeNull();
  });
});
