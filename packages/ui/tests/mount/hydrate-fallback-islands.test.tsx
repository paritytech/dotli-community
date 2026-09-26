// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Spec decision 17: on the hydration fallback path (mount/hydrate-shell.tsx,
// mount/root.ts's hydrateRoot snapshot restore), the lazy islands swap still
// runs, so islands work there without any special code. This forces a real
// hydration mismatch against the real server output (helpers/shell-ssr.ts),
// then runs the real loader (mount/load-islands.ts's ensureIslands()) over
// the restored snapshot, the way apps/host/src/boot.ts does right after
// hydrateShell(), and exercises every island the way
// tests/components/shell/islands.test.tsx does against a normally hydrated
// shell. Runs in the `hydration` vitest project, which compiles components
// hydratable and strips Shell.tsx's client templates the way the host build
// does (see vitest.config.ts); that project already proves the islands chunk
// compiles and runs there (islands.test.tsx), so this test lives alongside
// it rather than in a project that cannot run it.

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
import { renderShellOnServer } from "../helpers/shell-ssr";
import { stubColorScheme } from "../helpers/color-scheme";
import { hydrateShell } from "@dotli/ui/mount/hydrate-shell";
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

let serverHtml = "";

describe("shell islands after a hydration fallback", () => {
  beforeAll(async () => {
    serverHtml = await renderShellOnServer();
  });

  beforeEach(() => {
    vi.unstubAllGlobals();
    stubColorScheme("dark");
    localStorage.clear();
    sentry.captureException.mockClear();
    delete (globalThis as { _$HY?: unknown })._$HY;
  });

  afterEach(() => {
    disposeRoot("island:theme");
    disposeRoot("island:url-pill");
    disposeRoot("island:offline-banner");
    disposeRoot("shell");
    resetAllStoresForTests();
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("As a dotli user whose shell hydration failed, the swapped-in islands still work", async () => {
    // Given: a prerender with a hydration key the client does not know (the
    // same forced mismatch as hydrate-shell.test.tsx's fallback test), so
    // hydration fails and the snapshot-restore fallback runs.
    const staleKey = /_hk=\S+( class="mode-popover-backdrop")/;
    expect(serverHtml).toMatch(staleKey);
    const staleHtml = serverHtml.replace(staleKey, "_hk=stale$1");
    document.body.innerHTML = `<div id="shell" style="display: contents">${staleHtml}</div>`;
    const shell = byId("shell");
    // Solid's dev build may warn about the key miss; expected here.
    vi.spyOn(console, "warn").mockImplementation(() => {});

    hydrateShell();

    expect(shell.dataset.hydrated).toBe("fallback");
    expect(sentry.captureException).toHaveBeenCalledWith(expect.any(Error), {
      root: "shell",
      kind: "hydration_failed",
    });

    // The static nodes from the restored (fallback) snapshot, captured
    // before the swap: proves the swap actually ran (node identity), not
    // just that the observed behaviour matches what a swap would produce.
    // load-islands.ts's offline-banner failsafe in particular reproduces
    // the same offline/online behaviour from the static node when the
    // banner island itself fails to swap, so behaviour alone can't tell the
    // two apart.
    const staleIslandNodes = {
      "theme-toggle": byId("theme-toggle"),
      "theme-popover": byId("theme-popover"),
      "topbar-url": byId("topbar-url"),
      "offline-banner": byId("offline-banner"),
    };

    // When: the host boots the islands over the restored snapshot, exactly
    // as apps/host/src/boot.ts calls ensureIslands() right after
    // hydrateShell().
    await ensureIslands();
    await flushAll();

    // Then: each island's static markup was replaced by its live component,
    // one element per id, over the restored (not the originally hydrated)
    // snapshot. The pre-swap static node for each is detached and a
    // different, live node now carries the id.
    for (const [id, stale] of Object.entries(staleIslandNodes)) {
      expect(countById(id)).toBe(1);
      expect(byId(id)).not.toBe(stale);
      expect(stale.isConnected).toBe(false);
    }

    // Theme toggle: opens its popover and applies a selected option.
    const themeButton = byId("theme-toggle");
    themeButton.click();
    await flushAll();
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

    // No island reported an error: the only report is the forced mismatch.
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
  });
});
