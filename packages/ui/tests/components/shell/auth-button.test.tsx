// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { AuthButton } from "@dotli/ui/components/shell/AuthButton";
import { getAuthModalState } from "@dotli/ui/state/auth-modal";
import { setAuthState } from "@dotli/ui/state/auth";
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
  return byId<HTMLButtonElement>("auth-button");
}

/**
 * The button as topbar.ts left it. Logged in, it also carries the ARIA of a
 * Radix-style popover trigger for the user popover it opens.
 */
function expectMarkup(button: Element, expected: Element): void {
  if (expected.getAttribute("aria-label") === "Account") {
    expected.setAttribute("aria-haspopup", "dialog");
    expected.setAttribute("aria-expanded", "false");
    expected.setAttribute("aria-controls", "user-popover");
  }
  expect(normalized(button).isEqualNode(normalized(expected))).toBe(true);
}

describe("AuthButton", () => {
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

    // Then: still showing the badge, but announcing no popup.
    expect(button.textContent).toBe("PG");
    expect(popupAria()).toEqual([null, null, null]);

    // When
    setAuthState({ tag: "Authenticating" });
    await settleAll();

    // Then
    expect(popupAria()).toEqual([null, null, null]);

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
