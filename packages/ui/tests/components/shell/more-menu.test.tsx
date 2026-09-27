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
import { pointerPress, resetStores, settle } from "../../helpers/solid";
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

/**
 * The static markup plus the ARIA of a Radix DropdownMenu: the button
 * announces the menu it opens, and the flyout is a focusable menu, named by
 * the button, whose rows are menu items reached by roving focus.
 */
function expected(id: string): Element {
  const el = original(id).cloneNode(true) as Element;
  if (id === "more-button") {
    el.setAttribute("aria-haspopup", "menu");
  } else {
    el.setAttribute("role", "menu");
    el.setAttribute("aria-labelledby", "more-button");
    el.setAttribute("tabindex", "-1");
    for (const row of el.querySelectorAll(".more-row")) {
      row.setAttribute("role", "menuitem");
      row.setAttribute("tabindex", "-1");
    }
  }
  return el;
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
  it("As a mobile user, the More button and flyout render the shell's static markup plus the menu ARIA, closed and without the Chat row, with no warning", async () => {
    // Given
    const warn = vi.spyOn(console, "warn");
    const error = vi.spyOn(console, "error");

    // When
    await renderMenu();

    // Then
    for (const id of ["more-button", "more-popover"]) {
      expect(document.querySelectorAll(`[id="${id}"]`)).toHaveLength(1);
      expect(normalized(byId(id)).isEqualNode(normalized(expected(id)))).toBe(
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
    pointerPress(byId("outside"));
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

  it("As a screen-reader user, the More button announces the menu it opens, and the rows are its menu items", async () => {
    // When
    await renderMenu();

    // Then
    const button = byId("more-button");
    expect(button.getAttribute("aria-haspopup")).toBe("menu");
    expect(button.getAttribute("aria-controls")).toBe("more-popover");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    const popover = byId("more-popover");
    expect(popover.getAttribute("role")).toBe("menu");
    expect(popover.getAttribute("aria-labelledby")).toBe("more-button");
    expect(popover.getAttribute("tabindex")).toBe("-1");
    for (const el of popover.querySelectorAll(".more-row")) {
      expect(el.getAttribute("role")).toBe("menuitem");
      expect(el.getAttribute("tabindex")).toBe("-1");
    }
  });

  it("As a keyboard user, Enter on the More button opens the flyout on its first visible row, and the arrow keys and typeahead move between rows", async () => {
    // Given
    await renderMenu();
    byId("more-button").focus();

    // When
    await pressKey("Enter");

    // Then: the hidden Chat row is skipped.
    expect(isOpen()).toBe(true);
    expect(document.activeElement).toBe(row("permissions-button"));

    // When / Then
    await pressKey("ArrowDown");
    expect(document.activeElement).toBe(row("theme-toggle"));
    await pressKey("s");
    expect(document.activeElement).toBe(row("mode-button"));
    await pressKey("ArrowDown");
    expect(document.activeElement).toBe(row("permissions-button"));
    await pressKey("End");
    expect(document.activeElement).toBe(row("mode-button"));
  });

  it("As a mouse user, tapping the More button focuses the flyout itself", async () => {
    // When
    await openMenu();

    // Then
    expect(document.activeElement).toBe(byId("more-popover"));
  });

  it("As a keyboard user, Tab in the open flyout is prevented, so focus stays in it", async () => {
    // Given
    await openMenu();
    row("theme-toggle").focus();

    // When
    const tab = new KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true,
    });
    row("theme-toggle").dispatchEvent(tab);
    await settle();

    // Then
    expect(tab.defaultPrevented).toBe(true);
    expect(isOpen()).toBe(true);
    expect(document.activeElement).toBe(row("theme-toggle"));
  });

  it("As a mobile user, a tap outside the flyout only closes it: the tap does not reach what is underneath", async () => {
    // Given
    await openMenu();
    const clicks = vi.fn();
    byId("outside").addEventListener("click", clicks);

    // When
    pointerPress(byId("outside"));
    await settle();

    // Then
    expect(isOpen()).toBe(false);
    expect(clicks).not.toHaveBeenCalled();
  });

  it("As a keyboard user, choosing a row closes the flyout and hands focus back to the More button before the row forwards its click", async () => {
    // Given
    await openMenu();
    const theme = target("theme-toggle");
    let focusAtForward: Element | null = null;
    theme.el.addEventListener("click", () => {
      focusAtForward = document.activeElement;
    });
    row("theme-toggle").focus();

    // When: a focused button turns Enter into a click.
    row("theme-toggle").click();
    await settle();

    // Then
    expect(theme.clicks()).toBe(1);
    expect(focusAtForward).toBe(byId("more-button"));
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(byId("more-button"));
  });
});
