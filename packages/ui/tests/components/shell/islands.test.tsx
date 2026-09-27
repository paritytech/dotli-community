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
import { setTopbarVisible } from "@dotli/ui/state/topbar";
import { setAuthState, setLoggedIn } from "@dotli/ui/state/auth";
import { updateAuthModal } from "@dotli/ui/state/auth-modal";
import {
  normalized,
  oldAuthButton,
  oldModal,
  oldUserPopover,
} from "./old-auth-markup";
import {
  oldPermissionsBackdrop,
  oldPermissionsButton,
  oldPermissionsPopover,
} from "./old-permissions-markup";
import { oldChainsButton, oldChainsPopover } from "./old-chains-markup";
import {
  oldModeBackdrop,
  oldModeButton,
  oldModePopover,
} from "./old-settings-markup";
import { initSettingsStore } from "@dotli/ui/state/settings";
import { registerPermissionAuthorizationProvider } from "@dotli/ui/permissions";
import { setChainsButtonVisible } from "@dotli/ui/topbar";
import { setProductLoaded } from "@dotli/ui/state/product";
import {
  setVerificationShieldState,
  showLocalhostPill,
  showProductPill,
} from "@dotli/ui/state/url-pill";

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
const AUTH_IDS = ["auth-button", "user-popover", "auth-modal-backdrop"];
const PERMISSIONS_IDS = [
  "permissions-button",
  "permissions-popover-backdrop",
  "permissions-popover",
];
const CHAINS_IDS = ["chains-button", "chains-popover"];
const SETTINGS_IDS = ["mode-button", "mode-popover-backdrop", "mode-popover"];

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
    // The island sets its style property by property, the prerender as one
    // string: compare the declarations, not how they are spelled.
    if (node instanceof HTMLElement && node.hasAttribute("style")) {
      node.setAttribute("style", node.style.cssText);
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
    disposeRoot("island:url-pill");
    disposeRoot("island:offline-banner");
    disposeRoot("island:auth-button");
    disposeRoot("island:user-popover");
    disposeRoot("island:auth-modal");
    disposeRoot("island:permissions");
    disposeRoot("island:chains");
    disposeRoot("island:settings");
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
    const failed = mountIslands();
    await flushAll();

    // Then
    expect(failed).toEqual([]);
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

  it("As a keyboard user focused on a static element with an id, focus moves to the live element with that id, wherever it sits", async () => {
    // Given: a focusable static element whose live counterpart sits
    // elsewhere in the island (here the shield button, which the live pill
    // nests inside `#url-pill`).
    showProductPill("app", ".dot.li");
    setVerificationShieldState("verified");
    const staticShield = document.createElement("button");
    staticShield.id = "verification-shield";
    byId("topbar-url").append(staticShield);
    staticShield.focus();
    expect(document.activeElement).toBe(staticShield);

    // When
    mountIslands();
    await flushAll();

    // Then
    expect(staticShield.isConnected).toBe(false);
    expect(byId("verification-shield")).not.toBe(staticShield);
    expect(document.activeElement).toBe(byId("verification-shield"));
  });

  it("As a keyboard user focused on a static element without an id, focus moves to the live element at the same place", async () => {
    // Given: the options are buttons with tabindex="-1".
    const staticOption = themeOption("dark") as HTMLElement;
    staticOption.focus();
    expect(document.activeElement).toBe(staticOption);

    // When
    mountIslands();
    await flushAll();

    // Then
    expect(staticOption.isConnected).toBe(false);
    expect(document.activeElement).toBe(themeOption("dark"));
    expect(document.activeElement?.tagName).toBe("BUTTON");
  });

  it("As a keyboard user focused on a static node whose live counterpart is not focusable, focus moves to the first focusable element in it", async () => {
    // Given: the live `#theme-popover` is a plain div, not focusable.
    const staticPopover = byId("theme-popover");
    staticPopover.setAttribute("tabindex", "-1");
    staticPopover.focus();
    expect(document.activeElement).toBe(staticPopover);

    // When
    mountIslands();
    await flushAll();

    // Then
    expect(staticPopover.isConnected).toBe(false);
    expect(byId("theme-popover").hasAttribute("tabindex")).toBe(false);
    expect(document.activeElement).toBe(themeOption("light"));
  });

  it("As a keyboard user focused on a static node whose live counterpart has nothing focusable, the unfocusable live node is not focused", async () => {
    // Given: the live banner is a status region with nothing to focus.
    const staticBanner = byId("offline-banner");
    staticBanner.setAttribute("tabindex", "-1");
    staticBanner.focus();
    expect(document.activeElement).toBe(staticBanner);

    // When
    mountIslands();
    await flushAll();

    // Then
    const liveBanner = byId("offline-banner");
    expect(liveBanner).not.toBe(staticBanner);
    expect(document.activeElement).not.toBe(liveBanner);
    expect(liveBanner.contains(document.activeElement)).toBe(false);
  });

  it("As a dotli user, a theme island that throws while rendering leaves the static markup in place and is reported once", async () => {
    // Given
    themeIsland.broken = true;
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const before = THEME_IDS.map(byId);

    // When
    const failed = mountIslands();
    await flushAll();

    // Then
    expect(failed).toEqual(["theme"]);
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

  it("As a dotli user, an island that throws outside its error boundary is reported once, keeps its static markup and does not stop the other islands", async () => {
    // Given
    const staticBar = byId("topbar-url");
    const staticBanner = byId("offline-banner");
    const failure = new Error("the swap broke");
    vi.spyOn(staticBar, "replaceWith").mockImplementation(() => {
      throw failure;
    });
    const staticToggle = byId("theme-toggle");

    // When
    const failed = mountIslands();
    await flushAll();

    // Then
    expect(failed).toEqual(["url-pill"]);
    expect(byId("topbar-url")).toBe(staticBar);
    expect(countById("topbar-url")).toBe(1);
    expect(byId("theme-toggle")).not.toBe(staticToggle);
    expect(byId("offline-banner")).not.toBe(staticBanner);
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    expect(sentry.captureException).toHaveBeenCalledWith(failure, {
      root: "island:url-pill",
      kind: "island_mount_error",
    });
  });

  it("As a dotli user, an island whose static node is missing from the page is reported once and the other islands still mount", async () => {
    // Given
    byId("offline-banner").remove();
    const staticToggle = byId("theme-toggle");
    const staticBar = byId("topbar-url");

    // When
    const failed = mountIslands();
    await flushAll();

    // Then
    expect(failed).toEqual(["offline-banner"]);
    expect(countById("offline-banner")).toBe(0);
    expect(byId("theme-toggle")).not.toBe(staticToggle);
    expect(byId("topbar-url")).not.toBe(staticBar);
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    expect(sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({
        message:
          "[islands] island:offline-banner has no #offline-banner on the page",
      }),
      { root: "island:offline-banner", kind: "island_missing_node" },
    );
  });

  // ensureIslands mounts once per module, and reloading the module would
  // load a second Solid, so this is the file's only ensureIslands test.
  it("As a dotli user, a click on the theme button while the islands are still loading opens the menu once they mount, even when another island throws while mounting", async () => {
    // Given
    const { ensureIslands } = await import("@dotli/ui/mount/load-islands");
    const staticBar = byId("topbar-url");
    vi.spyOn(staticBar, "replaceWith").mockImplementation(() => {
      throw new Error("the swap broke");
    });
    const staticButton = byId("theme-toggle");

    // When
    const loading = ensureIslands();
    staticButton.click();
    await loading;
    await flushAll();

    // Then
    expect(byId("topbar-url")).toBe(staticBar);
    expect(byId("theme-toggle")).not.toBe(staticButton);
    expect(byId("theme-popover").classList.contains("open")).toBe(true);
    expect(byId("theme-toggle").getAttribute("aria-expanded")).toBe("true");
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    expect(sentry.captureException).toHaveBeenCalledWith(expect.any(Error), {
      root: "island:url-pill",
      kind: "island_mount_error",
    });
  });

  it("As a dotli user, the URL bar's static markup is swapped in place for the live pill, which matches it, with no warning", async () => {
    // Given
    const warn = vi.spyOn(console, "warn");
    const error = vi.spyOn(console, "error");
    const staticBar = byId("topbar-url");
    const place = placeOf(staticBar);
    const markup = withoutStoreState(staticBar);

    // When
    mountIslands();
    await flushAll();

    // Then
    const liveBar = byId("topbar-url");
    expect(countById("topbar-url")).toBe(1);
    expect(liveBar).not.toBe(staticBar);
    expect(staticBar.isConnected).toBe(false);
    expect(placeOf(liveBar)).toEqual(place);
    expect(withoutStoreState(liveBar).isEqualNode(markup)).toBe(true);
    expect(liveBar.matches(":empty")).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it("As a visitor of a product resolved before the islands loaded, the swapped-in pill shows it with its shield state", async () => {
    // Given: main.ts writes the store before the chunk arrives.
    showProductPill("app", ".dot.li");
    setVerificationShieldState("verified");

    // When
    mountIslands();
    await flushAll();

    // Then
    expect(countById("topbar-url")).toBe(1);
    expect(countById("url-pill")).toBe(1);
    expect(byId("topbar-url").querySelector(".dot-domain")?.textContent).toBe(
      "app",
    );
    expect(byId("verification-shield").classList.contains("verified")).toBe(
      true,
    );
  });

  it("As a dotli user, the swapped-in pill follows the store and its shield opens", async () => {
    // Given
    mountIslands();
    await flushAll();

    // When
    showLocalhostPill("localhost:3000");
    await flushAll();

    // Then
    expect(byId("url-pill").classList.contains("localhost-pill")).toBe(true);
    expect(byId("topbar-url").querySelector(".dot-domain")?.textContent).toBe(
      "localhost:3000",
    );

    // When
    showProductPill("app", ".dot.li");
    await flushAll();
    byId("verification-shield").click();
    await flushAll();

    // Then
    expect(byId("verification-tooltip").classList.contains("open")).toBe(true);
    expect(byId("verification-shield").getAttribute("aria-expanded")).toBe(
      "true",
    );
  });

  it("As a dotli user online, the offline banner's hidden static markup is swapped in place, as the topbar's last child, for the live banner, with no warning", async () => {
    // Given
    const warn = vi.spyOn(console, "warn");
    const error = vi.spyOn(console, "error");
    const staticBanner = byId("offline-banner");
    expect(staticBanner.parentElement).toBe(byId("topbar"));
    expect(staticBanner.style.display).toBe("none");
    const place = placeOf(staticBanner);
    const markup = withoutStoreState(staticBanner);

    // When
    mountIslands();
    await flushAll();

    // Then
    const liveBanner = byId("offline-banner");
    expect(countById("offline-banner")).toBe(1);
    expect(liveBanner).not.toBe(staticBanner);
    expect(staticBanner.isConnected).toBe(false);
    expect(placeOf(liveBanner)).toEqual(place);
    expect(byId("topbar").lastElementChild).toBe(liveBanner);
    expect(withoutStoreState(liveBanner).isEqualNode(markup)).toBe(true);
    expect(liveBanner.style.display).toBe("none");
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it("As a user offline when the islands mount, the swapped-in banner shows, follows the connection and hides with the topbar", async () => {
    // Given
    let online = false;
    vi.spyOn(navigator, "onLine", "get").mockImplementation(() => online);

    // When
    mountIslands();
    await flushAll();

    // Then
    expect(byId("offline-banner").style.display).toBe("block");

    // When
    setTopbarVisible(false);
    await flushAll();

    // Then
    expect(byId("offline-banner").style.display).toBe("none");

    // When
    setTopbarVisible(true);
    online = true;
    window.dispatchEvent(new Event("online"));
    await flushAll();

    // Then
    expect(byId("offline-banner").style.display).toBe("none");

    // When
    online = false;
    window.dispatchEvent(new Event("offline"));
    await flushAll();

    // Then
    expect(byId("offline-banner").style.display).toBe("block");
  });

  it("As a dotli user, the auth button, user popover and pairing modal are swapped in place for live islands matching what the topbar rendered, one element per id, with no warning", async () => {
    // Given: the static button says it is connecting, disabled.
    const warn = vi.spyOn(console, "warn");
    const error = vi.spyOn(console, "error");
    const staticButton = byId("auth-button");
    expect(staticButton.hasAttribute("disabled")).toBe(true);
    expect(staticButton.getAttribute("aria-busy")).toBe("true");
    expect(staticButton.title).toBe("Connecting...");
    const before = AUTH_IDS.map((id) => {
      const el = byId(id);
      return { el, place: placeOf(el) };
    });

    // When
    mountIslands();
    await flushAll();

    // Then
    for (const [i, id] of AUTH_IDS.entries()) {
      const fresh = byId(id);
      expect(countById(id)).toBe(1);
      expect(fresh).not.toBe(before[i].el);
      expect(before[i].el.isConnected).toBe(false);
      expect(placeOf(fresh)).toEqual(before[i].place);
    }
    const liveButton = byId("auth-button");
    expect(liveButton.hasAttribute("disabled")).toBe(false);
    expect(liveButton.hasAttribute("aria-busy")).toBe(false);
    expect(
      normalized(liveButton).isEqualNode(
        normalized(oldAuthButton("logged-out")),
      ),
    ).toBe(true);
    // The popover gains the tabindex its focus trap needs.
    const popover = oldUserPopover({ username: "", hint: false, open: false });
    popover.setAttribute("tabindex", "-1");
    expect(
      normalized(byId("user-popover")).isEqualNode(normalized(popover)),
    ).toBe(true);
    expect(
      normalized(byId("auth-modal-backdrop")).isEqualNode(
        normalized(
          oldModal({
            open: false,
            hint: "Scan with Polkadot Mobile to connect",
            getAppHidden: true,
            body: { kind: "empty" },
          }),
        ),
      ),
    ).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it("As a returning user whose session and login came before the islands loaded, the swapped-in islands show them", async () => {
    // Given: what the eager auth controller keeps from boot on.
    setAuthState({
      tag: "Connected",
      session: {
        connected: true,
        primaryUsername: "alice",
        liteUsername: "alice",
      },
    });
    setLoggedIn(true);
    updateAuthModal({
      open: true,
      productLabel: "app.dot",
      reason: null,
      view: { kind: "spinner" },
    });

    // When
    mountIslands();
    await flushAll();

    // Then
    expect(byId("auth-button").querySelector(".user-badge")?.textContent).toBe(
      "AL",
    );
    expect(byId("user-popover-username").textContent).toBe("alice");
    expect(byId("auth-modal-backdrop").classList.contains("open")).toBe(true);
    expect(byId("auth-modal-title").textContent).toBe(
      "app.dot is asking you to sign in",
    );
    expect(document.activeElement).toBe(byId("auth-modal-backdrop"));
  });

  it("As a visitor on the landing page, the auth button is swapped in where the page moved it, and opens the user popover there", async () => {
    // Given: ui.ts moves the button into the landing page's corner.
    const landingAuth = document.createElement("div");
    landingAuth.id = "landing-auth";
    document.body.append(landingAuth);
    landingAuth.append(byId("auth-button"));
    setAuthState({
      tag: "Connected",
      session: { connected: true, liteUsername: "pgherveou.04" },
    });
    setLoggedIn(true);

    // When
    mountIslands();
    await flushAll();

    // Then
    expect(countById("auth-button")).toBe(1);
    expect(placeOf(byId("auth-button"))).toEqual({
      parent: landingAuth,
      index: 0,
    });

    // When
    byId("auth-button").click();
    await flushAll();

    // Then
    expect(byId("user-popover").classList.contains("open")).toBe(true);
    expect(document.activeElement).toBe(byId("user-popover"));
  });

  it("As a dotli user, the permissions button, backdrop and popover are swapped in place for a live island matching what the topbar rendered, one element per id, with no warning", async () => {
    // Given
    const warn = vi.spyOn(console, "warn");
    const error = vi.spyOn(console, "error");
    const before = PERMISSIONS_IDS.map((id) => {
      const el = byId(id);
      return { el, place: placeOf(el) };
    });

    // When
    mountIslands();
    await flushAll();

    // Then
    for (const [i, id] of PERMISSIONS_IDS.entries()) {
      const fresh = byId(id);
      expect(countById(id)).toBe(1);
      expect(fresh).not.toBe(before[i].el);
      expect(before[i].el.isConnected).toBe(false);
      expect(placeOf(fresh)).toEqual(before[i].place);
    }
    expect(
      normalized(byId("permissions-button")).isEqualNode(
        normalized(oldPermissionsButton({ open: false, hasGrants: false })),
      ),
    ).toBe(true);
    expect(
      normalized(byId("permissions-popover-backdrop")).isEqualNode(
        normalized(oldPermissionsBackdrop(false)),
      ),
    ).toBe(true);
    expect(
      normalized(byId("permissions-popover")).isEqualNode(
        normalized(
          oldPermissionsPopover({ open: false, list: { kind: "empty" } }),
        ),
      ),
    ).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it("As a mobile user, the More menu's Permissions row opens the swapped-in popover, and an app loaded before the islands shows its grants", async () => {
    // Given: an app with a grant, loaded before the islands; and topbar.ts's
    // More menu, which forwards a row tap as a click on the button it looks
    // up by id at click time.
    const unregister = registerPermissionAuthorizationProvider("app.dot", {
      getPermissionAuthorizationStatuses: async (requests) =>
        requests.map((request) =>
          request.tag === "Device" && request.value === "Camera"
            ? "Authorized"
            : "NotDetermined",
        ),
      setPermissionAuthorizationStatus: async () => {},
    });
    setProductLoaded("app.dot", "app.dot");
    const row = document.querySelector(
      '#more-popover .more-row[data-target="permissions-button"]',
    ) as HTMLElement;
    row.addEventListener("click", (e) => {
      e.stopPropagation();
      document.getElementById(row.dataset.target ?? "")?.click();
    });

    try {
      // When
      mountIslands();
      await flushAll();
      await flushAll();

      // Then
      expect(byId("permissions-button").classList.contains("has-grants")).toBe(
        true,
      );

      // When
      row.click();
      await flushAll();
      await flushAll();

      // Then
      expect(byId("permissions-popover").classList.contains("open")).toBe(true);
      expect(
        byId("permissions-popover-backdrop").classList.contains("open"),
      ).toBe(true);
      expect(document.activeElement).toBe(byId("permissions-popover"));
      expect(byId("permissions-popover-status-Camera").textContent).toBe(
        "Allowed",
      );
    } finally {
      unregister();
    }
  });
  it("As a dotli user, the network button and popover are swapped in place for a live island matching what the topbar rendered, one element per id, with no warning", async () => {
    // Given
    const warn = vi.spyOn(console, "warn");
    const error = vi.spyOn(console, "error");
    const before = CHAINS_IDS.map((id) => {
      const el = byId(id);
      return { el, place: placeOf(el) };
    });

    // When
    mountIslands();
    await flushAll();

    // Then
    for (const [i, id] of CHAINS_IDS.entries()) {
      const fresh = byId(id);
      expect(countById(id)).toBe(1);
      expect(fresh).not.toBe(before[i].el);
      expect(before[i].el.isConnected).toBe(false);
      expect(placeOf(fresh)).toEqual(before[i].place);
    }
    expect(
      normalized(byId("chains-button")).isEqualNode(
        normalized(oldChainsButton({ open: false, visible: false })),
      ),
    ).toBe(true);
    expect(
      normalized(byId("chains-popover")).isEqualNode(
        normalized(oldChainsPopover({ open: false })),
      ),
    ).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it("As a visitor whose product rendered before the islands loaded, the swapped-in network button shows, keeps following the host and opens", async () => {
    // Given: the host reveals the button on the static markup.
    setChainsButtonVisible(true);
    expect(byId("chains-button").classList.contains("visible")).toBe(true);

    // When
    mountIslands();
    await flushAll();

    // Then
    expect(
      normalized(byId("chains-button")).isEqualNode(
        normalized(oldChainsButton({ open: false, visible: true })),
      ),
    ).toBe(true);

    // When
    byId("chains-button").click();
    await flushAll();

    // Then
    expect(byId("chains-popover").classList.contains("open")).toBe(true);
    expect(document.activeElement).toBe(byId("chains-popover"));
    expect(
      byId("chains-popover").querySelector(".chains-status")?.textContent,
    ).toBe("Starting");

    // When
    setChainsButtonVisible(false);
    await flushAll();

    // Then
    expect(byId("chains-button").classList.contains("visible")).toBe(false);
  });

  it("As a dotli user, the settings button, backdrop and popover are swapped in place for a live island matching what the topbar rendered, one element per id, with no warning", async () => {
    // Given: the host seeds the settings store at boot, before the islands.
    initSettingsStore();
    const warn = vi.spyOn(console, "warn");
    const error = vi.spyOn(console, "error");
    const before = SETTINGS_IDS.map((id) => {
      const el = byId(id);
      return { el, place: placeOf(el) };
    });

    // When
    mountIslands();
    await flushAll();

    // Then
    for (const [i, id] of SETTINGS_IDS.entries()) {
      const fresh = byId(id);
      expect(countById(id)).toBe(1);
      expect(fresh).not.toBe(before[i].el);
      expect(before[i].el.isConnected).toBe(false);
      expect(placeOf(fresh)).toEqual(before[i].place);
    }
    expect(
      normalized(byId("mode-button")).isEqualNode(
        normalized(oldModeButton({ open: false, verified: true })),
      ),
    ).toBe(true);
    expect(
      normalized(byId("mode-popover-backdrop")).isEqualNode(
        normalized(oldModeBackdrop({ open: false })),
      ),
    ).toBe(true);
    expect(
      normalized(byId("mode-popover")).isEqualNode(
        normalized(oldModePopover({ open: false })),
      ),
    ).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(sentry.captureException).not.toHaveBeenCalled();

    // When
    byId("mode-button").click();
    await flushAll();

    // Then
    expect(byId("mode-popover").classList.contains("open")).toBe(true);
    expect(byId("mode-popover-backdrop").classList.contains("open")).toBe(true);
    expect(document.activeElement).toBe(byId("mode-popover"));
    expect(
      byId("mode-popover").querySelector(".mode-popover-sheet-title")
        ?.textContent,
    ).toBe("Settings");
  });
});
