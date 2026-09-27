// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The mobile "More" flyout island (components/shell/MoreMenu.tsx). Its rows
// reaching the real permissions, theme and settings islands are covered in
// permissions-popover, theme-toggle and islands tests, and a row tapped
// before its target's island mounts in tests/mount/load-islands.test.ts.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setChatCapability } from "@dotli/shared/chat-capability";
import { initChatPanelState } from "@dotli/ui/state/chat-panel";
import { setBlockingModalActive } from "@dotli/ui/state/topbar";
import { resetStores, settle } from "../../helpers/solid";
import { normalized } from "./old-auth-markup";
import { mountMoreMenu } from "./more-menu-harness";

const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock("@dotli/metrics/sentry", () => sentry);

const FIXTURE = readFileSync(
  resolve(import.meta.dirname, "original-shell.html"),
  "utf8",
);

/** The element with `id` in the shell's original static markup. */
function original(id: string): Element {
  const template = document.createElement("template");
  template.innerHTML = FIXTURE;
  return template.content.querySelector(`[id="${id}"]`) as Element;
}

function byId(id: string): HTMLElement {
  return document.getElementById(id) as HTMLElement;
}

function row(targetId: string): HTMLElement {
  return document.querySelector(
    `#more-popover .more-row[data-target="${targetId}"]`,
  ) as HTMLElement;
}

function isOpen(): boolean {
  return byId("more-popover").classList.contains("open");
}

async function pressKey(key: string): Promise<void> {
  (document.activeElement ?? document.body).dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
  );
  await settle();
}

let cleanups: (() => void)[] = [];

/** The menu, swapped in for the static markup, and a button outside it. */
async function renderMenu(): Promise<void> {
  const template = document.createElement("template");
  template.innerHTML = FIXTURE;
  const moreButton = template.content.querySelector("#more-button");
  const morePopover = template.content.querySelector("#more-popover");
  const outside = document.createElement("button");
  outside.id = "outside";
  document.body.append(moreButton as Node, morePopover as Node, outside);
  cleanups.push(mountMoreMenu(), () => {
    outside.remove();
  });
  await settle();
}

async function openMenu(): Promise<void> {
  await renderMenu();
  byId("more-button").click();
  await settle();
}

/** A button standing in for a row's target island, counting its clicks. */
function target(id: string): { clicks: () => number; el: HTMLButtonElement } {
  const el = document.createElement("button");
  el.id = id;
  let clicks = 0;
  el.addEventListener("click", () => {
    clicks += 1;
  });
  document.body.append(el);
  cleanups.push(() => {
    el.remove();
  });
  return { clicks: () => clicks, el };
}

beforeEach(() => {
  sentry.captureException.mockClear();
  localStorage.clear();
});

afterEach(() => {
  for (const cleanup of cleanups) {
    cleanup();
  }
  cleanups = [];
  resetStores();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("MoreMenu", () => {
  it("As a mobile user, the More button and flyout render exactly the shell's static markup, closed and without the Chat row, with no warning", async () => {
    // Given
    const warn = vi.spyOn(console, "warn");
    const error = vi.spyOn(console, "error");

    // When
    await renderMenu();

    // Then
    for (const id of ["more-button", "more-popover"]) {
      expect(document.querySelectorAll(`[id="${id}"]`)).toHaveLength(1);
      expect(normalized(byId(id)).isEqualNode(normalized(original(id)))).toBe(
        true,
      );
    }
    expect(byId("more-row-chat").hidden).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it("As a mobile user, tapping the More button opens the flyout and tapping it again closes it", async () => {
    // Given
    await renderMenu();

    // When
    byId("more-button").click();
    await settle();

    // Then
    expect(isOpen()).toBe(true);
    expect(byId("more-button").getAttribute("aria-expanded")).toBe("true");

    // When
    byId("more-button").click();
    await settle();

    // Then
    expect(isOpen()).toBe(false);
    expect(byId("more-button").getAttribute("aria-expanded")).toBe("false");
  });

  it.each([
    ["Chat", "chat-button"],
    ["Permissions", "permissions-button"],
    ["Theme", "theme-toggle"],
    ["Settings", "mode-button"],
  ])(
    "As a mobile user, the %s row forwards my tap to the button it names, looked up when I tap, and closes the flyout",
    async (_label, id) => {
      // Given: the target is swapped for a new element after the menu
      // mounted, as an island does.
      await openMenu();
      const before = target(id);
      const after = target(id);
      before.el.remove();
      const outsideClicks = vi.fn();
      document.addEventListener("click", outsideClicks);
      cleanups.push(() => {
        document.removeEventListener("click", outsideClicks);
      });

      // When
      row(id).click();
      await settle();

      // Then
      expect(after.clicks()).toBe(1);
      expect(before.clicks()).toBe(0);
      expect(isOpen()).toBe(false);
      expect(byId("more-button").getAttribute("aria-expanded")).toBe("false");
      // Only the forwarded click bubbled to the document, not the row's own.
      expect(outsideClicks).toHaveBeenCalledTimes(1);
      expect(outsideClicks.mock.calls[0][0].target).toBe(after.el);
    },
  );

  it("As a mobile user, the Chat row shows whenever the chat button would", async () => {
    // Given
    cleanups.push(initChatPanelState());
    await renderMenu();
    expect(byId("more-row-chat").hidden).toBe(true);

    // When: a product with chat loads and a session is active.
    window.dispatchEvent(
      new CustomEvent("dotli:product-loaded", { detail: { label: "app.dot" } }),
    );
    setChatCapability("app.dot", true);
    window.dispatchEvent(
      new CustomEvent("dotli:truapi-auth-state", {
        detail: { tag: "Connected" },
      }),
    );
    await settle();

    // Then
    expect(byId("more-row-chat").hidden).toBe(false);

    // When
    window.dispatchEvent(
      new CustomEvent("dotli:truapi-auth-state", {
        detail: { tag: "Disconnected" },
      }),
    );
    await settle();

    // Then
    expect(byId("more-row-chat").hidden).toBe(true);
  });

  it("As a keyboard user, Escape closes the flyout and focus goes back to the More button", async () => {
    // Given
    await openMenu();
    row("permissions-button").focus();

    // When
    await pressKey("Escape");

    // Then
    expect(isOpen()).toBe(false);
    expect(byId("more-button").getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(byId("more-button"));
  });

  it("As a mobile user, tapping outside the flyout closes it", async () => {
    // Given
    await openMenu();

    // When
    byId("outside").click();
    await settle();

    // Then
    expect(isOpen()).toBe(false);
    expect(byId("more-button").getAttribute("aria-expanded")).toBe("false");
  });

  it("As a mobile user, a tap inside the flyout but not on a row leaves it open", async () => {
    // Given
    await openMenu();

    // When
    byId("more-popover").click();
    await settle();

    // Then
    expect(isOpen()).toBe(true);
  });

  it("As a mobile user, the flyout closes when a blocking modal comes up", async () => {
    // Given
    await openMenu();

    // When
    setBlockingModalActive(true);
    await settle();

    // Then
    expect(isOpen()).toBe(false);
    expect(byId("more-button").getAttribute("aria-expanded")).toBe("false");
  });
});
