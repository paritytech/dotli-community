// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@dotli/protocol/client", () => ({
  readSharedAuthStorage: async () => null,
  writeSharedAuthStorage: async () => undefined,
  clearSharedAuthStorage: async () => undefined,
  subscribeSharedAuthStorage: () => () => undefined,
  onProtocolChainSync: () => () => undefined,
}));

const BAR = ".chains-bar[data-block]";

/** The topbar markup `initTopBar` insists on, plus the network panel. */
function installDom(): void {
  document.body.innerHTML = `
    <a id="topbar-home"></a>
    <button id="auth-button" disabled></button>
    <div id="auth-modal-backdrop">
      <div id="auth-modal-title"></div>
      <div id="auth-modal-qr"></div>
      <div id="auth-modal-reason"></div>
      <div id="auth-modal-hint"></div>
      <a id="auth-modal-get-app" hidden></a>
      <button id="auth-modal-close"></button>
    </div>
    <div id="user-popover">
      <span id="user-popover-username"></span>
      <button id="user-popover-disconnect"></button>
    </div>
    <button id="theme-toggle" aria-expanded="false"></button>
    <div id="theme-popover" role="menu">
      <button class="theme-popover-option" role="menuitemradio" aria-checked="false" data-theme-option="light" tabindex="-1"></button>
      <button class="theme-popover-option" role="menuitemradio" aria-checked="false" data-theme-option="dark" tabindex="-1"></button>
      <button class="theme-popover-option" role="menuitemradio" aria-checked="false" data-theme-option="system" tabindex="-1"></button>
    </div>
    <button id="mode-button"></button>
    <div id="mode-popover"><div id="mode-popover-content"></div></div>
    <div id="mode-popover-backdrop"></div>
    <button id="permissions-button"></button>
    <div id="permissions-popover"><div id="permissions-popover-list"></div></div>
    <div id="permissions-popover-backdrop"></div>
    <button id="chains-button" aria-expanded="false"></button>
    <div class="more-popover chains-popover" id="chains-popover"></div>
  `;
}

/**
 * happy-dom does no layout, so every box measures zero and the slide would be
 * skipped for having no distance to travel. Give the marks the width the
 * stylesheet gives them.
 */
function stubLayout(): void {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    function (this: Element) {
      const isBar = this.classList.contains("chains-bar");
      return {
        width: isBar ? 4 : 200,
        height: isBar ? 22 : 22,
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect;
    },
  );
}

/** Push a block onto the one chain these tests drive. */
let emit: (blockNumber: number) => void;

/** Open the panel against a block source the test drives by hand. */
async function openPanel(): Promise<HTMLElement> {
  const monitor = await import("@dotli/ui/network-monitor");
  const { getActiveChainRoles } = await import("@dotli/config/network");
  const relay = getActiveChainRoles()[0].genesis;
  const emitters = new Map<string, (n: number) => void>();
  emit = (n) => {
    const push = emitters.get(relay);
    if (push === undefined) {
      throw new Error("nothing subscribed to the relay");
    }
    push(n);
  };
  const { initTopBar } = await import("@dotli/ui/topbar");
  // `initTopBar` installs the real source, so the fake has to land after it
  // and before the panel opens and starts watching.
  initTopBar();
  monitor.setBlockSource({
    isReachable: () => true,
    subscribe: (genesis, onBlock) => {
      emitters.set(genesis, onBlock);
      return () => {
        emitters.delete(genesis);
      };
    },
  });
  document.getElementById("chains-button")?.click();
  const strip = document
    .getElementById("chains-popover")
    ?.querySelector<HTMLElement>(".chains-bars");
  if (strip === null || strip === undefined) {
    throw new Error("the panel rendered no bar strip");
  }
  return strip;
}

beforeEach(async () => {
  vi.resetModules();
  vi.restoreAllMocks();
  localStorage.clear();
  installDom();
  stubLayout();
  const monitor = await import("@dotli/ui/network-monitor");
  monitor.resetNetworkMonitor();
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("The network panel's blocks arrive as motion", () => {
  it("As a user watching a chain, the newest block sits at the right-hand end", async () => {
    // Given
    const strip = await openPanel();

    // When three blocks land in order
    emit(100);
    emit(101);
    emit(102);

    // Then the last mark in the strip is the newest, and the strip packs to
    // the right so that is the end the visitor sees it arrive at.
    const marks = strip.querySelectorAll<HTMLElement>(BAR);
    expect([...marks].map((m) => m.dataset.block)).toEqual(["101", "102"]);
    expect(getComputedStyle(strip).flexDirection).not.toBe("row-reverse");
  });

  it("As a user watching a chain, a block already on screen keeps its own bar", async () => {
    // Given two blocks already drawn
    const strip = await openPanel();
    emit(100);
    emit(101);
    emit(102);
    const first = strip.querySelector<HTMLElement>('[data-block="101"]');

    // When another block lands
    emit(103);

    // Then the earlier bar is the same element, not a rebuilt copy, which is
    // what lets it be animated rather than replaced.
    expect(strip.querySelector('[data-block="101"]')).toBe(first);
  });

  it("As a user watching a chain, the strip glides left as the new block appears", async () => {
    // Given a strip with bars already on it
    const strip = await openPanel();
    emit(100);
    emit(101);
    emit(102);

    // When the next block lands
    emit(103);

    // Then the strip is offset by the room the new bar took and handed a
    // transition to close it, and the new bar is marked for its own entrance.
    expect(strip.classList.contains("is-sliding")).toBe(true);
    expect(strip.style.transform).toBe("translateX(0)");
    const newest = strip.querySelector<HTMLElement>('[data-block="103"]');
    expect(newest?.classList.contains("is-new")).toBe(true);
  });

  it("As a user opening the panel on a chain with history, nothing slides", async () => {
    // Given a panel opened when the chain already has bars, the whole strip
    // is drawn at once and there is no arrival to animate.
    const strip = await openPanel();

    // When the very first block is drawn
    emit(100);
    emit(101);

    // Then
    expect(strip.classList.contains("is-sliding")).toBe(false);
  });
});
