// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The shell islands chunk (components/shell/islands.tsx) swapping its live
// components in for the static markup of the real prerendered shell
// (helpers/shell-ssr.ts), after the shell has hydrated, as the host boots.
// Runs in the `hydration` vitest project, which compiles components
// hydratable and strips Shell.tsx's templates the way the host build does
// (see vitest.config.ts).

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { flush } from "solid-js";
import { renderShellOnServer } from "../../helpers/shell-ssr";
import { stubColorScheme } from "../../helpers/color-scheme";
import { mountIslands } from "@dotli/ui/components/shell/islands";
import { hydrateShell } from "@dotli/ui/mount/hydrate-shell";
import { disposeRoot } from "@dotli/ui/mount/root";
import { initTheme } from "@dotli/ui/theme-controller";
import { resetAllStoresForTests } from "@dotli/ui/state/create-store";

const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock("@dotli/metrics/sentry", () => sentry);

// Lets a test make the theme island throw while it renders.
const themeIsland = vi.hoisted(() => ({ broken: false }));
vi.mock("@dotli/ui/components/shell/ThemeToggle", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@dotli/ui/components/shell/ThemeToggle")
    >();
  return {
    ThemeToggle: () => {
      if (themeIsland.broken) {
        throw new Error("the theme island broke");
      }
      return actual.ThemeToggle();
    },
  };
});

const THEME_IDS = ["theme-toggle", "theme-popover"];

let serverHtml = "";

function byId(id: string): HTMLElement {
  return document.getElementById(id) as HTMLElement;
}

function themeOption(pref: string): HTMLElement | null {
  return document.querySelector(
    `.theme-popover-option[data-theme-option="${pref}"]`,
  );
}

/** How many elements in the document carry `id`. */
function countById(id: string): number {
  return document.querySelectorAll(`[id="${id}"]`).length;
}

/** Where `el` sits: its parent and its index among the parent's children. */
function placeOf(el: Element): { parent: Element | null; index: number } {
  const parent = el.parentElement;
  return {
    parent,
    index: parent === null ? -1 : [...parent.children].indexOf(el),
  };
}

/**
 * `el` without what differs by design between the prerender and the island:
 * the prerender's hydration keys, and the labels and checks the island
 * renders from the theme store (the prerender shows no preference).
 */
function withoutStoreState(el: Element): Element {
  const copy = el.cloneNode(true) as Element;
  for (const node of [copy, ...copy.querySelectorAll("*")]) {
    node.removeAttribute("_hk");
    if (node.id === "theme-toggle") {
      node.setAttribute("title", "Theme");
      node.setAttribute("aria-label", "Theme");
    }
    if (node.hasAttribute("aria-checked")) {
      node.setAttribute("aria-checked", "false");
    }
  }
  return copy;
}

async function flushAll(): Promise<void> {
  flush();
  await Promise.resolve();
  flush();
}

describe("shell islands", () => {
  beforeAll(async () => {
    serverHtml = await renderShellOnServer();
  });

  beforeEach(async () => {
    vi.unstubAllGlobals();
    stubColorScheme("dark");
    localStorage.clear();
    themeIsland.broken = false;
    sentry.captureException.mockClear();
    delete (globalThis as { _$HY?: unknown })._$HY;
    document.body.innerHTML = `<div id="shell" style="display: contents">${serverHtml}</div>`;
    hydrateShell();
    await flushAll();
  });

  afterEach(() => {
    disposeRoot("island:theme");
    disposeRoot("shell");
    resetAllStoresForTests();
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("As a dotli user, the theme toggle's static markup is swapped in place for the live island, one element per id, with no warning", async () => {
    // Given
    expect(byId("shell").dataset.hydrated).toBe("shell");
    const warn = vi.spyOn(console, "warn");
    const error = vi.spyOn(console, "error");
    const before = THEME_IDS.map((id) => {
      const el = byId(id);
      return { el, place: placeOf(el), markup: withoutStoreState(el) };
    });

    // When
    mountIslands();
    await flushAll();

    // Then
    for (const [i, id] of THEME_IDS.entries()) {
      const fresh = byId(id);
      expect(countById(id)).toBe(1);
      expect(fresh).not.toBe(before[i].el);
      expect(before[i].el.isConnected).toBe(false);
      expect(placeOf(fresh)).toEqual(before[i].place);
      expect(withoutStoreState(fresh).isEqualNode(before[i].markup)).toBe(true);
    }
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it("As a returning user, the swapped-in theme toggle shows my stored theme and its menu applies a new one", async () => {
    // Given
    localStorage.setItem("dotli-theme", "light");
    mountIslands();
    await flushAll();

    // When: initTopBar applies the stored theme.
    initTheme();
    await flushAll();

    // Then
    const btn = byId("theme-toggle");
    expect(btn.title).toBe("Theme: Light");
    expect(themeOption("light")?.getAttribute("aria-checked")).toBe("true");

    // When
    btn.click();
    await flushAll();

    // Then
    expect(byId("theme-popover").classList.contains("open")).toBe(true);
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(themeOption("light"));

    // When
    themeOption("dark")?.click();
    await flushAll();

    // Then
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(btn.title).toBe("Theme: Dark");
    expect(themeOption("dark")?.getAttribute("aria-checked")).toBe("true");
    expect(byId("theme-popover").classList.contains("open")).toBe(false);
  });

  it("As a visitor on the landing page, the theme toggle is swapped in where the page moved it, outside the shell, and works there", async () => {
    // Given: ui.ts moves both into the landing page's top-right corner.
    const landingAuth = document.createElement("div");
    landingAuth.id = "landing-auth";
    document.body.append(landingAuth);
    landingAuth.append(byId("theme-toggle"), byId("theme-popover"));

    // When
    mountIslands();
    await flushAll();

    // Then
    for (const [i, id] of THEME_IDS.entries()) {
      expect(countById(id)).toBe(1);
      expect(placeOf(byId(id))).toEqual({ parent: landingAuth, index: i });
    }

    // When
    byId("theme-toggle").click();
    await flushAll();

    // Then
    expect(byId("theme-popover").classList.contains("open")).toBe(true);
    expect(document.activeElement).toBe(themeOption("system"));
  });

  it("As a keyboard user who had focused the static theme button, focus stays on the button once the island swaps in", async () => {
    // Given
    const staticButton = byId("theme-toggle");
    staticButton.focus();
    expect(document.activeElement).toBe(staticButton);

    // When
    mountIslands();
    await flushAll();

    // Then
    expect(byId("theme-toggle")).not.toBe(staticButton);
    expect(document.activeElement).toBe(byId("theme-toggle"));
  });

  it("As a dotli user, a theme island that throws while rendering leaves the static markup in place and is reported once", async () => {
    // Given
    themeIsland.broken = true;
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const before = THEME_IDS.map(byId);

    // When
    mountIslands();
    await flushAll();

    // Then
    for (const [i, id] of THEME_IDS.entries()) {
      expect(byId(id)).toBe(before[i]);
      expect(countById(id)).toBe(1);
    }
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    expect(sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: "the theme island broke" }),
      { root: "island:theme" },
    );
  });

  it("As a dotli user, a click on the theme button while the islands are still loading opens the menu once they mount", async () => {
    // Given
    const { ensureIslands } = await import("@dotli/ui/mount/load-islands");
    const staticButton = byId("theme-toggle");

    // When
    const loading = ensureIslands();
    staticButton.click();
    await loading;
    await flushAll();

    // Then
    expect(byId("theme-toggle")).not.toBe(staticButton);
    expect(byId("theme-popover").classList.contains("open")).toBe(true);
    expect(byId("theme-toggle").getAttribute("aria-expanded")).toBe("true");
  });
});
