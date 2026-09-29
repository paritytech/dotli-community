// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flush } from "solid-js";
import { setBackend, setCacheSettings, setNetwork } from "@dotli/config";

import { SettingsPopover } from "../../../src/components/shell/SettingsPopover.js";
import { initSettingsStore } from "../../../src/state/settings.js";
import { setBlockingModalActive } from "../../../src/state/topbar.js";
import {
  pointerPress,
  pointerPressUnfocusable,
  renderComponent,
  resetStores,
  tabTo,
} from "../../helpers/solid.js";
import { normalized } from "./old-auth-markup.js";
import { mountMoreMenu, tapMoreRow } from "./more-menu-harness.js";
import {
  oldModeBackdrop,
  oldModeButton,
  oldModePopover,
  type OldSettings,
} from "./old-settings-markup.js";
import type * as SettingsActionsModule from "../../../src/settings-actions.js";
import type * as NetworkModule from "../../../../config/src/network.js";
import { byId, query } from "../../support.js";

const actions = vi.hoisted(() => ({ applyAndReset: vi.fn() }));
vi.mock("../../../src/settings-actions.js", async (importOriginal) => ({
  ...(await importOriginal<typeof SettingsActionsModule>()),
  applyAndReset: actions.applyAndReset,
}));

// No chain answers here: the share report's block heights read "n/a".
vi.mock("../../../../protocol/src/client.js", () => ({
  isRemoteChainSupported: () => false,
  createRemoteChainProvider: () => null,
}));

const rpc = vi.hoisted(() => ({ live: null as string | null }));
vi.mock("../../../../resolver/src/rpc-resolve.js", () => ({
  getConnectedAssetHubRpcEndpoint: () => rpc.live,
}));

const networks = vi.hoisted(() => ({
  enabled: null as ReturnType<typeof NetworkModule.getEnabledNetworks> | null,
}));
vi.mock("../../../../config/src/network.js", async (importOriginal) => {
  const actual = await importOriginal<typeof NetworkModule>();
  return {
    ...actual,
    getEnabledNetworks: () => networks.enabled ?? actual.getEnabledNetworks(),
  };
});

const DEFAULT_CACHE = {
  skipCidCache: false,
  skipArchiveCache: false,
  skipWorkerCache: false,
};

let cleanups: (() => void)[] = [];

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  actions.applyAndReset.mockReset();
  actions.applyAndReset.mockResolvedValue(undefined);
  rpc.live = null;
  networks.enabled = null;
});

afterEach(() => {
  for (const cleanup of cleanups) {
    cleanup();
  }
  cleanups = [];
  resetStores();
  // The copy test's clipboard.
  Reflect.deleteProperty(navigator, "clipboard");
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

async function settle(): Promise<void> {
  flush();
  await Promise.resolve();
  flush();
}

/** Let the lazy imports and promise chains a click starts finish. */
async function drain(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    flush();
  }
}

function isOpen(): boolean {
  return byId("mode-popover").classList.contains("open");
}

function press(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  (document.activeElement ?? document.body).dispatchEvent(event);
  return event;
}

function button(text: string): HTMLButtonElement {
  const found = Array.from(
    byId("mode-popover").querySelectorAll<HTMLButtonElement>("button"),
  ).find((b) => b.textContent === text);
  if (found === undefined) {
    throw new Error(`no "${text}" button`);
  }
  return found;
}

function applyButton(): HTMLButtonElement {
  return query(document, ".mode-apply-row button", HTMLButtonElement);
}

function toggle(label: string): HTMLButtonElement {
  return query(
    document,
    `[role="switch"][aria-label="${label}"]`,
    HTMLButtonElement,
  );
}

function radio(name: string, value: string): HTMLInputElement {
  return query(
    document,
    `input[name="${name}"][value="${value}"]`,
    HTMLInputElement,
  );
}

function infoRow(label: string): HTMLElement {
  const found = Array.from(
    document.querySelectorAll<HTMLElement>(".mode-info-row"),
  ).find((row) => row.firstElementChild?.textContent === label);
  if (found === undefined) {
    throw new Error(`no "${label}" row`);
  }
  return found;
}

/**
 * The viewport width against the CSS breakpoint where the popover becomes a
 * full-screen sheet, `(max-width: 560px)`: happy-dom cannot evaluate it.
 * Flip `narrow` to resize.
 */
function stubViewport(narrow: boolean): { narrow: boolean } {
  const viewport = { narrow };
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches() {
      return query === "(max-width: 560px)" && viewport.narrow;
    },
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
  return viewport;
}

/** The popover's controls that Tab reaches, in order. */
function tabbables(): HTMLElement[] {
  return Array.from(
    byId("mode-popover").querySelectorAll<HTMLElement>(
      "button:not([disabled]), input:not([disabled])",
    ),
  ).filter((el) => !(el instanceof HTMLInputElement && !el.checked));
}

async function renderPopover({ seed = true } = {}): Promise<void> {
  if (seed) {
    initSettingsStore();
  }
  const { unmount } = renderComponent(() => (
    <div>
      <SettingsPopover />
      <button id="outside" type="button">
        Outside
      </button>
    </div>
  ));
  cleanups.push(unmount);
  await settle();
}

async function openPopover(): Promise<void> {
  byId("mode-button").click();
  await settle();
  expect(isOpen()).toBe(true);
}

function expectPopoverMatches(settings: OldSettings): void {
  expect(
    normalized(byId("mode-popover")).isEqualNode(
      normalized(oldModePopover({ open: true, ...settings })),
    ),
  ).toBe(true);
  // isEqualNode leaves out the `checked` property, which the old code set.
  const checked = Array.from(
    document.querySelectorAll<HTMLInputElement>(".mode-radio-input"),
  )
    .filter((input) => input.checked)
    .map((input) => `${input.name}=${input.value}`);
  expect(checked).toEqual([
    ...(settings.enabledNetworks.length > 1
      ? [`dotli-network=${settings.network}`]
      : []),
    `dotli-backend=${settings.chain}`,
  ]);
}

describe("The settings popover island", () => {
  it("As a dotli user, the closed button, backdrop and popover match what the topbar rendered", async () => {
    // When
    await renderPopover();

    // Then
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
  });

  it("As a visitor on trusted providers, the button carries the trusted-provider mark", async () => {
    // Given
    setBackend("rpc-gateway");

    // When
    await renderPopover();

    // Then
    expect(
      normalized(byId("mode-button")).isEqualNode(
        normalized(oldModeButton({ open: false, verified: false })),
      ),
    ).toBe(true);
  });

  it("As the host booting, an island mounted before the settings store is seeded reads no setting itself and follows the store once seeded", async () => {
    // Given: a saved choice the config getters would rewrite when read (no
    // shared workers here), which the boot's URL settings step must see
    // first to tell the visitor about the fallback.
    localStorage.setItem("dotli:chain-backend", "smoldot-shared-worker");
    vi.stubGlobal("SharedWorker", undefined);

    // When
    await renderPopover({ seed: false });

    // Then
    expect(localStorage.getItem("dotli:chain-backend")).toBe(
      "smoldot-shared-worker",
    );
    expect(byId("mode-button").className).toBe("topbar-btn");

    // When: the host seeds the store.
    setBackend("rpc-gateway");
    initSettingsStore();
    await settle();

    // Then
    expect(byId("mode-button").className).toBe("topbar-btn gateway-mode");
  });

  it("As a mobile user opening it before the settings store is seeded, the sheet can be closed every way and fills in once the store is seeded", async () => {
    // Given: the islands mounted before the host seeded the settings.
    await renderPopover({ seed: false });

    // When
    await openPopover();

    // Then: no settings yet, but the sheet header and its close button are
    // there.
    expect(document.querySelector(".mode-popover-columns")).toBeNull();
    expect(document.querySelector(".mode-popover-sheet-close")).not.toBeNull();

    // When
    press("Escape");
    await settle();

    // Then
    expect(isOpen()).toBe(false);

    // When
    await openPopover();
    byId("mode-popover-backdrop").click();
    await settle();

    // Then
    expect(isOpen()).toBe(false);

    // When
    await openPopover();
    query(document, ".mode-popover-sheet-close").click();
    await settle();

    // Then
    expect(isOpen()).toBe(false);

    // When: opened again, then the host seeds the store.
    await openPopover();
    setNetwork("previewnet");
    initSettingsStore();
    await settle();

    // Then: the content appears without reopening.
    expect(isOpen()).toBe(true);
    expectPopoverMatches({
      chain: "smoldot-direct",
      network: "previewnet",
      cache: DEFAULT_CACHE,
      enabledNetworks: ["paseo-next-v2", "previewnet"],
      sharedWorkerSupported: typeof SharedWorker !== "undefined",
      debugOn: false,
    });
  });

  it("As a dotli user opening it with several networks, it matches what the topbar rendered", async () => {
    // Given
    setNetwork("previewnet");
    setCacheSettings({ ...DEFAULT_CACHE, skipArchiveCache: true });
    await renderPopover();

    // When
    await openPopover();

    // Then
    expect(byId("mode-button").getAttribute("aria-expanded")).toBe("true");
    expect(
      normalized(byId("mode-popover-backdrop")).isEqualNode(
        normalized(oldModeBackdrop({ open: true })),
      ),
    ).toBe(true);
    expectPopoverMatches({
      chain: "smoldot-direct",
      network: "previewnet",
      cache: { ...DEFAULT_CACHE, skipArchiveCache: true },
      enabledNetworks: ["paseo-next-v2", "previewnet"],
      sharedWorkerSupported: typeof SharedWorker !== "undefined",
      debugOn: false,
    });
  });

  it("As a dotli user opening it with one network, in debug mode, on trusted providers, without shared workers and with package versions, it matches what the topbar rendered", async () => {
    // Given
    networks.enabled = ["previewnet"];
    setNetwork("previewnet");
    setBackend("rpc-gateway");
    sessionStorage.setItem("dotli:truapi-debug", "1");
    vi.stubGlobal("SharedWorker", undefined);
    vi.stubGlobal("__POLKADOT_API_VERSION__", "1.2.3");
    vi.stubGlobal("__POLKADOT_API_VERSIONS__", [
      { name: "@polkadot-api/ws-provider", version: "0.4.0" },
    ]);
    vi.stubGlobal("__PARITY_TRUAPI_VERSIONS__", [
      { name: "@parity/truapi-host", version: "0.9.0" },
    ]);
    await renderPopover();

    // When
    await openPopover();

    // Then
    expectPopoverMatches({
      chain: "rpc-gateway",
      network: "previewnet",
      cache: DEFAULT_CACHE,
      enabledNetworks: ["previewnet"],
      sharedWorkerSupported: false,
      debugOn: true,
    });
  });

  it("As a dotli user, a change enables Save & Apply, undoing it disables it again, and Save & Apply applies the draft", async () => {
    // Given
    await renderPopover();
    await openPopover();
    expect(applyButton().disabled).toBe(true);

    // When
    toggle("dotNS cache").click();
    await settle();

    // Then
    expect(toggle("dotNS cache").getAttribute("aria-checked")).toBe("false");
    expect(toggle("dotNS cache").className).toBe("permissions-popover-toggle ");
    expect(applyButton().disabled).toBe(false);
    expect(applyButton().className).toBe("mode-clear-btn mode-apply-dirty");
    expect(
      document
        .querySelector(".mode-apply-warning")
        ?.classList.contains("visible"),
    ).toBe(true);

    // When
    toggle("dotNS cache").click();
    await settle();

    // Then
    expect(applyButton().disabled).toBe(true);
    expect(applyButton().className).toBe("mode-clear-btn");
    expect(
      document
        .querySelector(".mode-apply-warning")
        ?.classList.contains("visible"),
    ).toBe(false);

    // When
    radio("dotli-network", "previewnet").click();
    radio("dotli-backend", "rpc-gateway").click();
    toggle("Worker cache").click();
    await settle();
    applyButton().click();
    await settle();

    // Then
    expect(actions.applyAndReset).toHaveBeenCalledTimes(1);
    expect(actions.applyAndReset).toHaveBeenCalledWith(
      {
        chain: "rpc-gateway",
        network: "previewnet",
        cache: { ...DEFAULT_CACHE, skipWorkerCache: true },
      },
      {
        chain: "smoldot-direct",
        network: "paseo-next-v2",
        cache: DEFAULT_CACHE,
      },
    );
    expect(applyButton().disabled).toBe(true);
    expect(applyButton().textContent).toBe("Resetting…");
  });

  it("As a keyboard user, picking a transport keeps the focus on the checked radio", async () => {
    // Given
    await renderPopover();
    await openPopover();

    // When
    radio("dotli-backend", "rpc-gateway").click();
    await settle();

    // Then
    const checked = document.querySelector<HTMLInputElement>(
      '[role="radiogroup"][aria-label="Network Transport"] input:checked',
    );
    expect(checked?.value).toBe("rpc-gateway");
    expect(document.activeElement).toBe(checked);
    expect(checked?.closest("label")?.className).toBe(
      "mode-radio-row selected",
    );
  });

  it("As a dotli user, closing throws the draft away: the next open starts from the saved settings", async () => {
    // Given
    await renderPopover();
    await openPopover();
    toggle("Archive cache").click();
    await settle();

    // When
    press("Escape");
    await settle();
    await openPopover();

    // Then
    expect(toggle("Archive cache").getAttribute("aria-checked")).toBe("true");
    expect(applyButton().disabled).toBe(true);
  });

  it("As a dotli user, Clear all caches runs the full wipe with the saved settings", async () => {
    // Given
    setBackend("rpc-gateway");
    await renderPopover();
    await openPopover();
    toggle("dotNS cache").click();
    await settle();

    // When
    button("Clear all caches").click();
    await settle();

    // Then
    const saved = {
      chain: "rpc-gateway",
      network: "paseo-next-v2",
      cache: DEFAULT_CACHE,
    };
    expect(actions.applyAndReset).toHaveBeenCalledTimes(1);
    expect(actions.applyAndReset).toHaveBeenCalledWith(saved, saved, {
      forceFullWipe: true,
    });
    const clear = query(
      document,
      ".mode-clear-all-row button",
      HTMLButtonElement,
    );
    expect(clear.disabled).toBe(true);
    expect(clear.textContent).toBe("Clearing…");

    // When: a second click does nothing.
    clear.click();
    await settle();

    // Then
    expect(actions.applyAndReset).toHaveBeenCalledTimes(1);
  });

  it("As a dotli user, clicking a copyable diagnostics row copies it and flashes Copied for a second", async () => {
    // Given
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    await renderPopover();
    await openPopover();
    vi.useFakeTimers();
    const site = infoRow("Site");
    const value = query(site, "code");

    // When
    site.click();
    await Promise.resolve();
    await Promise.resolve();
    flush();

    // Then
    expect(writeText).toHaveBeenCalledWith(window.location.host);
    expect(value.textContent).toBe("Copied");
    expect(site.className).toBe(
      "mode-endpoint-row mode-info-row mode-info-row-copyable copied",
    );

    // When
    vi.advanceTimersByTime(1000);
    flush();

    // Then
    expect(value.textContent).toBe(window.location.host);
    expect(site.className).toBe(
      "mode-endpoint-row mode-info-row mode-info-row-copyable",
    );

    // When: a row that is not copyable.
    infoRow("Build").click();
    await Promise.resolve();

    // Then
    expect(writeText).toHaveBeenCalledTimes(1);
  });

  it("As a dotli user on trusted providers, the AssetHub row shows the node the client is connected to, in the popover and the shared report", async () => {
    // Given
    setBackend("rpc-gateway");
    rpc.live = "wss://live.example";
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    await renderPopover();

    // When
    await openPopover();
    await drain();

    // Then
    expect(infoRow("AssetHub node").querySelector("code")?.textContent).toBe(
      "wss://live.example",
    );

    // When
    button("Share diagnostic").click();
    await drain();

    // Then
    const url = new URL(open.mock.calls[0][0] as string);
    expect(url.searchParams.get("body")).toContain(
      "AssetHub node: wss://live.example",
    );
  });

  it("As a dotli user, Share diagnostic opens a GitHub issue prefilled with the diagnostics", async () => {
    // Given
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    await renderPopover();
    await openPopover();

    // When
    button("Share diagnostic").click();
    await drain();

    // Then
    expect(open).toHaveBeenCalledTimes(1);
    const [href, target, features] = open.mock.calls[0];
    const url = new URL(href as string);
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://github.com/paritytech/dotli/issues/new",
    );
    expect(target).toBe("_blank");
    expect(features).toBe("noopener,noreferrer");
    expect(url.searchParams.get("body")).toBe(
      [
        "<!-- Describe the issue above this line; the diagnostics below are auto-filled. -->",
        "",
        "## Diagnostics",
        "",
        "```",
        `Site: ${window.location.host}`,
        "Build: 0.0.0 (dev)",
        "Network: " +
          (infoRow("Network").querySelector("code")?.textContent ?? ""),
        "Network Transport: Light Client Per-Tab",
        `Browser: ${infoRow("Browser").querySelector("code")?.textContent ?? ""}`,
        "",
        "Cache:",
        "  dotNS cache: on",
        "  Archive cache: on",
        "  Worker cache: on",
        "",
        "Packages:",
        "  smoldot: unknown",
        "```",
      ].join("\n"),
    );
  });

  it("As a developer, the debug button reloads the tab with debug mode on, or off when it is on", async () => {
    // Given
    const assign = vi.fn();
    vi.stubGlobal("location", {
      href: "https://app.dot.li/path?x=1",
      assign,
    });
    await renderPopover();
    await openPopover();

    // When
    button("Open in debug mode").click();

    // Then
    expect(assign).toHaveBeenCalledWith(
      "https://app.dot.li/path?x=1&debug=true",
    );
  });

  it("As a developer in debug mode, the debug button reloads the tab with debug mode off", async () => {
    // Given
    sessionStorage.setItem("dotli:truapi-debug", "1");
    const assign = vi.fn();
    vi.stubGlobal("location", { href: "https://app.dot.li/", assign });
    await renderPopover();
    await openPopover();

    // When
    button("Exit debug mode").click();

    // Then
    expect(assign).toHaveBeenCalledWith("https://app.dot.li/?debug=off");
  });

  it("As a keyboard user, opening it focuses its first control, Tab loops inside, and Escape closes it, handing focus back to the button", async () => {
    // Given
    await renderPopover();

    // When
    await openPopover();

    // Then
    const focusables = Array.from(
      byId("mode-popover").querySelectorAll<HTMLElement>(
        "button:not([disabled]), input:not([disabled])",
      ),
    ).filter((el) => !(el instanceof HTMLInputElement && !el.checked));
    expect(document.activeElement).toBe(focusables[0]);
    focusables[focusables.length - 1].focus();

    // When
    const tab = press("Tab");

    // Then: Tab loops back to the first control.
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(focusables[0]);

    // When
    press("Escape");
    await settle();

    // Then
    expect(isOpen()).toBe(false);
    expect(byId("mode-popover-backdrop").classList.contains("open")).toBe(
      false,
    );
    expect(byId("mode-button").getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(byId("mode-button"));
  });

  it("As a screen-reader user, the button announces the dialog it opens and whether it is open", async () => {
    // Given
    await renderPopover();
    const settingsButton = byId("mode-button");
    const popover = byId("mode-popover");

    // Then
    expect(popover.getAttribute("role")).toBe("dialog");
    expect(popover.getAttribute("aria-label")).toBe("Settings");
    expect(settingsButton.getAttribute("aria-haspopup")).toBe("dialog");
    expect(settingsButton.getAttribute("aria-controls")).toBe("mode-popover");
    expect(settingsButton.getAttribute("aria-expanded")).toBe("false");

    // When
    await openPopover();

    // Then
    expect(settingsButton.getAttribute("aria-expanded")).toBe("true");
  });

  it("As a keyboard user on desktop, Tab past the last control keeps focus in the popover and leaves it open", async () => {
    // Given
    await renderPopover();
    byId("mode-button").focus();
    await openPopover();
    expect(byId("mode-popover").contains(document.activeElement)).toBe(true);
    const controls = byId("mode-popover").querySelectorAll<HTMLElement>(
      "button:not([disabled])",
    );
    controls[controls.length - 1].focus();
    await settle();
    expect(isOpen()).toBe(true);

    // When
    const tab = tabTo(byId("outside"));
    await settle();

    // Then
    expect(tab.defaultPrevented).toBe(true);
    expect(isOpen()).toBe(true);
    expect(byId("mode-popover").contains(document.activeElement)).toBe(true);
  });

  it("As a dotli user on desktop, a press on the backdrop closes it without handing focus back to the button", async () => {
    // Given
    await renderPopover();
    byId("mode-button").focus();
    await openPopover();

    // When: the backdrop covers the page, and takes no focus.
    pointerPressUnfocusable(byId("mode-popover-backdrop"));
    await settle();

    // Then: focus follows the press.
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(document.body);
  });

  it("As a mobile user who opened it from the More menu, closing the sheet hands focus to the More button", async () => {
    // Given: on narrow screens CSS hides the settings button, so it cannot
    // take focus; the sheet is reached through the More button.
    const more = document.createElement("button");
    more.id = "more-button";
    document.body.append(more);
    await renderPopover();
    byId("mode-button").focus = () => undefined;
    await openPopover();

    // When
    query(document, ".mode-popover-sheet-close").click();
    await settle();

    // Then
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(more);
  });

  it("As a dotli user, a click on the backdrop or outside closes it, and a click inside does not", async () => {
    // Given
    await renderPopover();
    await openPopover();

    // When
    query(document, ".mode-popover-columns").click();
    await settle();

    // Then
    expect(isOpen()).toBe(true);

    // When
    byId("mode-popover-backdrop").click();
    await settle();

    // Then
    expect(isOpen()).toBe(false);

    // When
    await openPopover();
    pointerPress(byId("outside"));
    await settle();

    // Then
    expect(isOpen()).toBe(false);
  });

  it("As a dotli user, a blocking modal coming up closes it", async () => {
    // Given
    await renderPopover();
    await openPopover();

    // When
    setBlockingModalActive(true);
    await settle();

    // Then
    expect(isOpen()).toBe(false);
    expect(byId("mode-popover-backdrop").classList.contains("open")).toBe(
      false,
    );
  });

  it("As a mobile user, the full-screen settings sheet is a modal dialog: it traps Tab, keeps focus, locks the page scroll and says it is modal", async () => {
    // Given
    stubViewport(true);
    document.body.style.overflow = "";
    await renderPopover();
    byId("mode-button").focus();

    // When
    await openPopover();

    // Then
    const popover = byId("mode-popover");
    expect(popover.getAttribute("role")).toBe("dialog");
    expect(popover.getAttribute("aria-modal")).toBe("true");
    expect(popover.contains(document.activeElement)).toBe(true);
    expect(document.body.hasAttribute("data-scroll-locked")).toBe(true);

    // When: Tab on the last control.
    const controls = tabbables();
    controls[controls.length - 1].focus();
    const tab = press("Tab");

    // Then: it wraps to the first.
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(controls[0]);

    // When: focus lands outside, as a modal dialog never lets it.
    byId("outside").focus();
    await settle();

    // Then: a dialog does not close on focus leaving it.
    expect(isOpen()).toBe(true);

    // When
    query(document, ".mode-popover-sheet-close").click();
    await settle();

    // Then
    expect(isOpen()).toBe(false);
    expect(popover.hasAttribute("aria-modal")).toBe(false);
    expect(document.body.hasAttribute("data-scroll-locked")).toBe(false);
  });

  it("As a desktop user, the settings popover is not modal: no aria-modal and no scroll lock, though Tab loops inside", async () => {
    // Given
    stubViewport(false);
    document.body.style.overflow = "";
    await renderPopover();

    // When
    await openPopover();

    // Then
    expect(byId("mode-popover").hasAttribute("aria-modal")).toBe(false);
    expect(document.body.hasAttribute("data-scroll-locked")).toBe(false);
    const controls = tabbables();
    controls[controls.length - 1].focus();
    expect(press("Tab").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(controls[0]);
  });

  it("As a user who resized the window, the settings open as a sheet or a popover by the width at each opening", async () => {
    // Given: opened wide, then closed.
    const viewport = stubViewport(false);
    await renderPopover();
    await openPopover();
    expect(byId("mode-popover").hasAttribute("aria-modal")).toBe(false);
    press("Escape");
    await settle();

    // When: narrowed, then opened again.
    viewport.narrow = true;
    await openPopover();

    // Then
    expect(byId("mode-popover").getAttribute("aria-modal")).toBe("true");
    const controls = tabbables();
    controls[controls.length - 1].focus();
    expect(press("Tab").defaultPrevented).toBe(true);

    // When: widened while open, then closed and opened.
    viewport.narrow = false;
    press("Escape");
    await settle();
    await openPopover();

    // Then
    expect(byId("mode-popover").hasAttribute("aria-modal")).toBe(false);
  });

  it("As a mobile user, the settings sheet I opened from the More menu takes focus, and closing it hands focus back to the More button", async () => {
    // Given: on narrow screens CSS hides the settings button, so it cannot
    // take focus; the sheet is reached through the More menu.
    stubViewport(true);
    await renderPopover();
    cleanups.push(mountMoreMenu());
    await settle();
    byId("mode-button").focus = () => undefined;

    // When
    await tapMoreRow("mode-button");
    await settle();

    // Then
    expect(byId("more-popover").classList.contains("open")).toBe(false);
    expect(isOpen()).toBe(true);
    expect(byId("mode-popover").contains(document.activeElement)).toBe(true);

    // When
    press("Escape");
    await settle();

    // Then
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(byId("more-button"));
  });
});
