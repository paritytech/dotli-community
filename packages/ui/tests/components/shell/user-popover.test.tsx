// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { AuthButton } from "@dotli/ui/components/shell/AuthButton";
import { requestTruapiDisconnect } from "@dotli/ui/auth-controller";
import { setAuthState } from "@dotli/ui/state/auth";
import { setBlockingModalActive } from "@dotli/ui/state/topbar";
import type { TruapiSessionUiState } from "@dotli/ui/host-callbacks/SessionStore";
import {
  pointerPress,
  pointerPressUnfocusable,
  renderComponent,
  tabTo,
} from "../../helpers/solid";
import {
  byId,
  press,
  recordEvents,
  settleAll,
  useAuthController,
} from "./auth-harness";
import { normalized, oldUserPopover } from "./old-auth-markup";

useAuthController();

const PUBLIC_KEY =
  "0x000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

/** The button and the popover, as their island, plus a button outside. */
async function renderAccount(
  session?: TruapiSessionUiState,
): Promise<HTMLElement> {
  renderComponent(() => (
    <div>
      <AuthButton />
      <button id="outside" type="button">
        Outside
      </button>
    </div>
  ));
  await settleAll();
  if (session !== undefined) {
    setAuthState({ tag: "Connected", session });
    await settleAll();
  }
  return byId("user-popover");
}

function isOpen(): boolean {
  return byId("user-popover").classList.contains("open");
}

/**
 * The popover as topbar.ts left it, plus what a Radix-style non-modal popover
 * carries: role="dialog", named by its "Welcome back" heading, and the
 * tabindex that lets it take focus.
 */
function expectMarkup(
  popover: Element,
  opts: Parameters<typeof oldUserPopover>[0],
): void {
  const expected = oldUserPopover(opts);
  expected.setAttribute("role", "dialog");
  expected.setAttribute("aria-label", "Welcome back");
  expected.setAttribute("tabindex", "-1");
  expect(normalized(popover).isEqualNode(normalized(expected))).toBe(true);
}

async function openPopover(): Promise<void> {
  byId("auth-button").click();
  await settleAll();
  expect(isOpen()).toBe(true);
}

describe("UserPopover", () => {
  it("As a logged-in user, the popover shows my username, with the markup the topbar rendered", async () => {
    // When
    const popover = await renderAccount({
      connected: true,
      publicKey: PUBLIC_KEY,
      liteUsername: "pgherveou.04",
      primaryUsername: "pgherveou.04",
    });

    // Then
    expect(byId("user-popover-username").textContent).toBe("pgherveou.04");
    expect(document.getElementById("user-popover-hint")).toBeNull();
    expectMarkup(popover, {
      username: "pgherveou.04",
      hint: false,
      open: false,
    });
  });

  it("As a user whose account has no username, the popover shows my shortened address and explains why", async () => {
    // When
    const popover = await renderAccount({
      connected: true,
      publicKey: PUBLIC_KEY,
    });

    // Then
    expect(byId("user-popover-username").textContent).toBe("0x000102...1e1f");
    expect(byId("user-popover-hint").textContent).toContain("No username");
    expectMarkup(popover, {
      username: "0x000102...1e1f",
      hint: true,
      open: false,
    });

    // When: reconnecting with a username clears the hint again.
    setAuthState({
      tag: "Connected",
      session: { connected: true, liteUsername: "pgherveou.04" },
    });
    await settleAll();

    // Then
    expect(byId("user-popover-username").textContent).toBe("pgherveou.04");
    expect(document.getElementById("user-popover-hint")).toBeNull();
  });

  it("As a user restored from a bare session, the popover says I am connected", async () => {
    // When
    const popover = await renderAccount({ connected: true });

    // Then
    expectMarkup(popover, {
      username: "Connected with Polkadot Mobile",
      hint: true,
      open: false,
    });
  });

  it("As a user whose username contains markup, the popover shows it as text", async () => {
    // When
    const popover = await renderAccount({
      connected: true,
      primaryUsername: "<b>x</b>",
    });

    // Then
    expect(popover.querySelector("b")).toBeNull();
    expect(byId("user-popover-username").textContent).toBe("<b>x</b>");
  });

  it("As a logged-out user, the popover has no hint", async () => {
    // Given
    await renderAccount({ connected: true, publicKey: PUBLIC_KEY });

    // When
    setAuthState({ tag: "Disconnected" });
    await settleAll();

    // Then
    expect(document.getElementById("user-popover-hint")).toBeNull();
  });

  it("As a logged-in user, the account button toggles the popover and Log out requests a disconnect through the Rust core", async () => {
    // Given
    const disconnects = recordEvents("dotli:truapi-disconnect-request");
    const loginRequests = recordEvents("dotli:truapi-login-request");
    await renderAccount({ connected: true, liteUsername: "pgherveou.04" });

    // When
    await openPopover();
    byId("auth-button").click();
    await settleAll();

    // Then
    expect(isOpen()).toBe(false);

    // When
    await openPopover();
    byId("user-popover-disconnect").click();
    await settleAll();

    // Then
    expect(disconnects.details).toHaveLength(1);
    expect(isOpen()).toBe(false);
    expect(loginRequests.details).toHaveLength(0);
  });

  it("As a dotli integrator, the controller emits the Rust-core disconnect request", () => {
    // Given
    const disconnects = recordEvents("dotli:truapi-disconnect-request");

    // When
    requestTruapiDisconnect();

    // Then
    expect(disconnects.details).toHaveLength(1);
  });

  it("As a keyboard user, the open popover takes focus, does not trap Tab and closes on Escape, handing focus back to the account button", async () => {
    // Given
    await renderAccount({ connected: true, liteUsername: "pgherveou.04" });
    byId("auth-button").focus();

    // When
    await openPopover();

    // Then: Log out is the only control.
    expect(document.activeElement).toBe(byId("user-popover-disconnect"));

    // When
    const tab = press("Tab");

    // Then: a non-modal popover lets Tab move on.
    expect(tab.defaultPrevented).toBe(false);

    // When
    press("Escape");
    await settleAll();

    // Then
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(byId("auth-button"));
  });

  it("As a screen-reader user, the account button announces the popover it opens and whether it is open", async () => {
    // Given
    const popover = await renderAccount({
      connected: true,
      liteUsername: "pgherveou.04",
    });
    const button = byId("auth-button");

    // Then
    expect(popover.getAttribute("role")).toBe("dialog");
    expect(popover.getAttribute("aria-label")).toBe("Welcome back");
    expect(button.getAttribute("aria-haspopup")).toBe("dialog");
    expect(button.getAttribute("aria-controls")).toBe("user-popover");
    expect(button.getAttribute("aria-expanded")).toBe("false");

    // When
    await openPopover();

    // Then
    expect(button.getAttribute("aria-expanded")).toBe("true");

    // When
    press("Escape");
    await settleAll();

    // Then
    expect(button.getAttribute("aria-expanded")).toBe("false");

    // When: logging out turns the button back into the login button.
    setAuthState({ tag: "Disconnected" });
    await settleAll();

    // Then: it announces the auth modal a click now opens instead.
    expect(button.getAttribute("aria-haspopup")).toBe("dialog");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(button.getAttribute("aria-controls")).toBe("auth-modal-backdrop");
  });

  it("As a keyboard user, Tab past Log out closes the popover and focus moves on", async () => {
    // Given
    await renderAccount({ connected: true, liteUsername: "pgherveou.04" });
    byId("auth-button").focus();
    await openPopover();
    expect(document.activeElement).toBe(byId("user-popover-disconnect"));

    // When
    const tab = tabTo(byId("outside"));
    await settleAll();

    // Then
    expect(tab.defaultPrevented).toBe(false);
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(byId("outside"));
  });

  it("As a logged-in user, a press outside closes the popover without handing focus back to the account button", async () => {
    // Given
    await renderAccount({ connected: true, liteUsername: "pgherveou.04" });
    byId("auth-button").focus();
    await openPopover();

    // When: the press lands on nothing that takes focus.
    pointerPressUnfocusable(document.body);
    await settleAll();

    // Then: focus follows the press, as in a Radix non-modal popover.
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(document.body);
  });

  it("As a logged-in user, a click outside closes the popover", async () => {
    // Given
    await renderAccount({ connected: true, liteUsername: "pgherveou.04" });
    await openPopover();

    // When
    byId("user-popover-username").click();
    await settleAll();

    // Then
    expect(isOpen()).toBe(true);

    // When
    pointerPress(byId("outside"));
    await settleAll();

    // Then
    expect(isOpen()).toBe(false);
  });

  it("As a logged-in user, a blocking modal coming up closes the popover", async () => {
    // Given
    await renderAccount({ connected: true, liteUsername: "pgherveou.04" });
    await openPopover();

    // When
    setBlockingModalActive(true);
    await settleAll();

    // Then
    expect(isOpen()).toBe(false);
  });

  it("As a returning user whose session was restored before the islands loaded, the popover shows my username as it mounts", async () => {
    // Given
    setAuthState({
      tag: "Connected",
      session: { connected: true, primaryUsername: "alice" },
    });

    // When
    await renderAccount();

    // Then
    expect(byId("user-popover-username").textContent).toBe("alice");
  });
});
