// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The host boot as a user meets it (apps/host/src/boot.ts): the page shows
// the prerendered shell as static HTML (the real server output,
// helpers/shell-ssr.ts), nothing hydrates it, and the real loader
// (mount/load-islands.ts's ensureIslands()) swaps the islands in over it.
// This checks what users and the imperative topbar code depend on: the
// static nodes outside the islands stay the very nodes the page painted, a
// click on a static trigger made while the islands load is not lost, and
// every island is live once swapped in. tests/components/shell/islands.test.tsx
// covers each island's swap in detail.

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
import { mouseClick } from "../helpers/solid";
import { renderShellOnServer } from "../helpers/shell-ssr";
import { stubColorScheme } from "../helpers/color-scheme";
import { ensureIslands } from "@dotli/ui/mount/load-islands";
import { disposeRoot } from "@dotli/ui/mount/root";
import { resetAllStoresForTests } from "@dotli/ui/state/create-store";
import { setTopbarVisible } from "@dotli/ui/state/topbar";
import {
  setVerificationShieldState,
  showProductPill,
} from "@dotli/ui/state/url-pill";

const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock("@dotli/metrics/sentry", () => sentry);

function byId(id: string): HTMLElement {
  return document.getElementById(id) as HTMLElement;
}

/** How many elements in the document carry `id`. */
function countById(id: string): number {
  return document.querySelectorAll(`[id="${id}"]`).length;
}

function themeOption(pref: string): HTMLElement | null {
  return document.querySelector(
    `.theme-popover-option[data-theme-option="${pref}"]`,
  );
}

async function flushAll(): Promise<void> {
  flush();
  await Promise.resolve();
  flush();
}

/** Shell nodes that are not islands: imperative code keeps references to them. */
const STATIC_IDS = [
  "topbar",
  "topbar-home",
  "chat-button",
  "chat-unread-badge",
];

let serverHtml = "";

describe("host boot over the prerendered shell", () => {
  beforeAll(async () => {
    serverHtml = await renderShellOnServer();
  });

  beforeEach(() => {
    vi.unstubAllGlobals();
    stubColorScheme("dark");
    localStorage.clear();
    sentry.captureException.mockClear();
  });

  afterEach(() => {
    disposeRoot("island:theme");
    disposeRoot("island:url-pill");
    disposeRoot("island:offline-banner");
    disposeRoot("island:auth-button");
    disposeRoot("island:user-popover");
    disposeRoot("island:auth-modal");
    disposeRoot("island:permissions");
    disposeRoot("island:chains");
    disposeRoot("island:settings");
    disposeRoot("island:more");
    resetAllStoresForTests();
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("As a dotli user, the islands swap in over the static shell, keep an early click, and work", async () => {
    // Given: the page as it is painted, before any script runs.
    document.body.innerHTML = `<div id="shell" style="display: contents">${serverHtml}</div>`;
    const warn = vi.spyOn(console, "warn");
    const error = vi.spyOn(console, "error");
    const staticNodes = new Map(STATIC_IDS.map((id) => [id, byId(id)]));
    // The static island nodes, captured before the swap: proves the swap
    // actually ran (node identity), not just that the observed behaviour
    // matches what a swap would produce. load-islands.ts's offline-banner
    // failsafe in particular reproduces the same offline/online behaviour
    // from the static node when the banner island fails to swap, so
    // behaviour alone can't tell the two apart.
    const staticIslandNodes = {
      "theme-toggle": byId("theme-toggle"),
      "theme-popover": byId("theme-popover"),
      "topbar-url": byId("topbar-url"),
      "offline-banner": byId("offline-banner"),
    };

    // When: the host boots the islands, and the user clicks the static
    // theme button before their chunk has arrived.
    const loading = ensureIslands();
    mouseClick(staticIslandNodes["theme-toggle"]);
    await loading;
    await flushAll();

    // Then: the rest of the shell is still the painted nodes.
    for (const [id, node] of staticNodes) {
      expect(node).not.toBeNull();
      expect(byId(id)).toBe(node);
    }

    // Each island's static markup was replaced by its live component, one
    // element per id. The static node for each is detached and a different,
    // live node now carries the id.
    for (const [id, stale] of Object.entries(staticIslandNodes)) {
      expect(countById(id)).toBe(1);
      expect(byId(id)).not.toBe(stale);
      expect(stale.isConnected).toBe(false);
    }

    // The early click was replayed on the live theme toggle: its menu is
    // open, and a selected option applies.
    expect(byId("theme-popover").classList.contains("open")).toBe(true);
    themeOption("light")?.click();
    await flushAll();
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(byId("theme-toggle").title).toBe("Theme: Light");
    expect(byId("theme-popover").classList.contains("open")).toBe(false);

    // URL pill: follows the store.
    showProductPill("app", ".dot.li");
    await flushAll();
    expect(countById("url-pill")).toBe(1);
    expect(byId("topbar-url").querySelector(".dot-domain")?.textContent).toBe(
      "app",
    );

    // Shield: its tooltip toggles.
    setVerificationShieldState("verified");
    await flushAll();
    expect(countById("verification-shield")).toBe(1);
    const shield = byId("verification-shield");

    shield.click();
    await flushAll();
    expect(byId("verification-tooltip").classList.contains("open")).toBe(true);

    shield.click();
    await flushAll();
    expect(byId("verification-tooltip").classList.contains("open")).toBe(false);

    // Offline banner: responds to offline/online while the topbar is
    // visible.
    let online = true;
    vi.spyOn(navigator, "onLine", "get").mockImplementation(() => online);
    setTopbarVisible(true);

    online = false;
    window.dispatchEvent(new Event("offline"));
    await flushAll();
    expect(byId("offline-banner").style.display).toBe("block");

    online = true;
    window.dispatchEvent(new Event("online"));
    await flushAll();
    expect(byId("offline-banner").style.display).toBe("none");

    // Nothing warned or went to Sentry.
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(sentry.captureException).not.toHaveBeenCalled();
  });
});
