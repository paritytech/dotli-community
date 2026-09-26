// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The theme island (components/shell/ThemeToggle.tsx) hydrating inside the
// real prerendered shell (helpers/shell-ssr.ts). Runs in the `hydration`
// vitest project, which compiles components hydratable and strips Shell.tsx's
// templates the way the host build does (see vitest.config.ts).

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
import { hydrateShell } from "@dotli/ui/mount/hydrate-shell";
import { disposeRoot } from "@dotli/ui/mount/root";
import { initTheme } from "@dotli/ui/theme-controller";
import { resetAllStoresForTests } from "@dotli/ui/state/create-store";

const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock("@dotli/metrics/sentry", () => sentry);

let serverHtml = "";

function byId(id: string): HTMLElement {
  return document.getElementById(id) as HTMLElement;
}

function themeOption(pref: string): HTMLElement | null {
  return document.querySelector(
    `.theme-popover-option[data-theme-option="${pref}"]`,
  );
}

/** Every node of the theme toggle and its menu, in document order. */
function themeNodes(): Node[] {
  const nodes: Node[] = [];
  for (const root of [byId("theme-toggle"), byId("theme-popover")]) {
    const walker = document.createTreeWalker(root);
    for (let node: Node | null = root; node; node = walker.nextNode()) {
      nodes.push(node);
    }
  }
  return nodes;
}

function hydrationMessages(spy: ReturnType<typeof vi.spyOn>): string[] {
  return spy.mock.calls
    .map((args) => args.map(String).join(" "))
    .filter((message) => /hydrat/i.test(message));
}

async function flushAll(): Promise<void> {
  flush();
  await Promise.resolve();
  flush();
}

describe("ThemeToggle hydration", () => {
  beforeAll(async () => {
    serverHtml = await renderShellOnServer();
  });

  beforeEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
    sentry.captureException.mockClear();
    delete (globalThis as { _$HY?: unknown })._$HY;
    document.body.innerHTML = `<div id="shell" style="display: contents">${serverHtml}</div>`;
  });

  afterEach(() => {
    disposeRoot("shell");
    resetAllStoresForTests();
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("As the prerender, the theme toggle renders today's static markup: no preference label and nothing checked", () => {
    // Then
    const btn = byId("theme-toggle");
    expect(btn.title).toBe("Theme");
    expect(btn.getAttribute("aria-label")).toBe("Theme");
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(byId("theme-popover").className).toBe("more-popover theme-popover");
    for (const pref of ["light", "dark", "system"]) {
      expect(themeOption(pref)?.getAttribute("aria-checked")).toBe("false");
    }
  });

  it("As a returning user, the theme toggle hydrates in place with no hydration warning, then shows my stored theme and opens its menu", async () => {
    // Given
    stubColorScheme("dark");
    localStorage.setItem("dotli-theme", "light");
    const warn = vi.spyOn(console, "warn");
    const error = vi.spyOn(console, "error");
    const before = themeNodes();

    // When: boot hydrates first, initTopBar applies the stored theme later.
    hydrateShell();
    await flushAll();
    initTheme();
    await flushAll();

    // Then
    expect(byId("shell").dataset.hydrated).toBe("shell");
    const after = themeNodes();
    expect(after.length).toBe(before.length);
    for (const [i, node] of before.entries()) {
      expect(after[i]).toBe(node);
    }
    expect(hydrationMessages(warn)).toEqual([]);
    expect(hydrationMessages(error)).toEqual([]);
    expect(sentry.captureException).not.toHaveBeenCalled();
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
    expect(byId("theme-popover").classList.contains("open")).toBe(false);
  });

  it("As a returning user whose theme is already in the store when the shell hydrates, hydration still matches and the label follows", async () => {
    // Given
    stubColorScheme("dark");
    localStorage.setItem("dotli-theme", "dark");
    initTheme();
    const warn = vi.spyOn(console, "warn");
    const error = vi.spyOn(console, "error");
    const before = themeNodes();

    // When
    hydrateShell();
    await flushAll();

    // Then
    expect(byId("shell").dataset.hydrated).toBe("shell");
    expect(themeNodes()).toEqual(before);
    expect(hydrationMessages(warn)).toEqual([]);
    expect(hydrationMessages(error)).toEqual([]);
    expect(byId("theme-toggle").title).toBe("Theme: Dark");
    expect(themeOption("dark")?.getAttribute("aria-checked")).toBe("true");
  });
});
