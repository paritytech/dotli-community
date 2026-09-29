// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The loading screen island (components/shell/LoadingScreen.tsx) swapped in
// for the static `.loading` markup of apps/host/index.html, rendering the
// loading store the controller writes.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";
import { flush } from "solid-js";

// ui.ts binds `#app` when it loads, so the element exists before any import
// runs and every test only ever replaces its children.
vi.hoisted(() => {
  document.body.innerHTML = `<div id="app"></div>`;
});

const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock("../../../../metrics/src/sentry.js", () => sentry);
// The landing page loads the recent names from the shared storage frame,
// which happy-dom would try to fetch.
vi.mock("../../../src/recent-labels.js", () => ({
  loadRecentLabels: () => Promise.resolve([]),
  forgetRecentLabel: () => Promise.resolve(),
}));

import {
  mountIslands,
  mountLoadingIsland,
} from "../../../src/components/shell/islands.js";
import * as ctl from "../../../src/loading-controller.js";
import {
  disposeAppRoot,
  disposeAppRoots,
  registerAppRoot,
} from "../../../src/mount/app-roots.js";
import { resetAllStoresForTests } from "../../../src/state/create-store.js";
import { getLoadingState, updateLoading } from "../../../src/state/loading.js";
import { showErrorPage } from "../../../src/ui.js";
import { showLanding } from "../../../src/landing/load.js";
import { byId } from "../../support.js";
import { nth } from "../../helpers/nth.js";

const INDEX_HTML = readFileSync(
  resolve(import.meta.dirname, "../../../../../apps/host/index.html"),
  "utf8",
);

/** The static loading screen exactly as apps/host/index.html ships it. */
function staticLoadingMarkup(): string {
  // Only `#app`, up to the first script after it: parsing the whole page
  // would make happy-dom fetch its scripts and stylesheets.
  const start = INDEX_HTML.indexOf(`<div id="app">`);
  const end = INDEX_HTML.indexOf("<script", start);
  const template = document.createElement("template");
  template.innerHTML = INDEX_HTML.slice(start, end);
  const loading = template.content.querySelector("#app > .loading");
  if (loading === null) {
    throw new Error("apps/host/index.html has no #app > .loading");
  }
  return loading.outerHTML;
}

const FADE_MS = 300;

// The status typewriter (loading-controller.ts) runs on animation frames,
// which the tests step by hand.
let frames: Map<number, FrameRequestCallback>;
let nextFrame = 0;

/** Run every animation frame requested so far, at `now`. */
function runFrames(now: number): void {
  const due = [...frames];
  frames.clear();
  for (const [, cb] of due) {
    cb(now);
  }
}

function app(): HTMLElement {
  return byId("app");
}

function countById(id: string): number {
  return document.querySelectorAll(`[id="${id}"]`).length;
}

function petals(root: ParentNode = document): SVGPathElement[] {
  return [...root.querySelectorAll<SVGPathElement>(".loading-petal")];
}

const BASE_CSS = readFileSync(
  resolve(import.meta.dirname, "../../../src/styles/base.css"),
  "utf8",
);

/** A CSS time (`-1.2s`, `200ms`) in milliseconds. */
function toMs(time: string): number {
  return time.endsWith("ms") ? parseFloat(time) : parseFloat(time) * 1_000;
}

/**
 * The animation a browser with `motion` as its reduced-motion preference
 * applies to each petal of `markup`, under styles/base.css. A window of its
 * own, so the preference and the stylesheet stay out of the test document.
 */
async function petalAnimations(
  markup: string,
  motion: "no-preference" | "reduce",
): Promise<{ animation: string; delayMs: number }[]> {
  const win = new Window({
    settings: { device: { prefersReducedMotion: motion } },
  });
  const style = win.document.createElement("style");
  style.textContent = BASE_CSS;
  win.document.head.append(style);
  win.document.body.innerHTML = markup;
  const result = [...win.document.querySelectorAll(".loading-petal")].map(
    (petal) => {
      const computed = win.getComputedStyle(petal);
      return {
        animation: computed.animation,
        delayMs: toMs(computed.animationDelay || "0s"),
      };
    },
  );
  await win.happyDOM.close();
  return result;
}

async function settle(): Promise<void> {
  flush();
  await Promise.resolve();
  flush();
}

/**
 * `el` as tag, attributes (sorted) and children, without what the store
 * writes as it goes (inline styles) and without comments and whitespace, so
 * static and live markup compare node for node.
 */
function shape(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return (node.textContent ?? "").trim();
  }
  if (!(node instanceof Element)) {
    return "";
  }
  const attrs = [...node.attributes]
    .filter((a) => a.name !== "style")
    .map((a) => `${a.name}="${a.value}"`)
    .sort()
    .join(" ");
  const children = [...node.childNodes]
    .map(shape)
    .filter((s) => s !== "")
    .join("");
  return `<${node.tagName.toLowerCase()} ${attrs}>${children}</>`;
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
  frames = new Map();
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    nextFrame += 1;
    frames.set(nextFrame, cb);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    frames.delete(id);
  });
  app().innerHTML = staticLoadingMarkup();
  sentry.captureException.mockClear();
});

afterEach(() => {
  disposeAppRoots();
  disposeAppRoot("island:loading");
  ctl.stopStatusTick();
  resetAllStoresForTests();
  app().innerHTML = "";
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Loading screen island", () => {
  it("As a visitor, the static loading screen is swapped in place for the live one, one element per id, with the same markup", async () => {
    // Given
    const stale = byId("app-loading");
    const before = shape(stale);
    const warn = vi.spyOn(console, "warn");
    const error = vi.spyOn(console, "error");

    // When
    const mounted = mountLoadingIsland();
    await settle();

    // Then
    expect(mounted).toBe(true);
    const fresh = byId("app-loading");
    expect(fresh).not.toBe(stale);
    expect(stale.isConnected).toBe(false);
    expect(fresh.parentElement).toBe(app());
    expect(app().children).toHaveLength(1);
    expect(fresh.classList.contains("loading")).toBe(true);
    expect(shape(fresh)).toBe(before);
    for (const id of [
      "app-loading",
      "loading-logo",
      "loading-progress",
      "loading-progress-fill",
      "loading-progress-pct",
      "loading-text",
      "loading-status",
      "status",
      "status-sr",
      "loading-warning",
      "loading-warning-text",
    ]) {
      expect(countById(id), id).toBe(1);
    }
    expect(petals()).toHaveLength(6);
    expect(fresh.hasAttribute("style")).toBe(false);
    expect(sentry.captureException).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("As a visitor, the islands chunk mounts the loading screen with the other islands", async () => {
    // Given
    const stale = byId("app-loading");

    // When
    const failed = mountIslands();
    await settle();

    // Then
    expect(failed).not.toContain("loading");
    expect(byId("app-loading")).not.toBe(stale);
    expect(countById("app-loading")).toBe(1);

    // Cleanup: the shell islands had no static nodes here, so none mounted.
    for (const name of [
      "theme",
      "url-pill",
      "offline-banner",
      "auth-button",
      "auth-modal",
      "permissions",
      "chains",
      "settings",
      "more",
    ]) {
      disposeAppRoot(`island:${name}`);
    }
  });

  it("As a visitor, progress, status and warning made before the swap show at once, and nothing restarts", async () => {
    // Given a load already underway
    updateLoading({
      progress: 37.4,
      statusText: "Downloading the app",
      statusOpacity: 0.8,
      srText: "Downloading the app",
      warning: "Still looking for peers",
    });
    const before = getLoadingState();

    // When
    mountLoadingIsland();

    // Then, straight from the first render
    expect(byId("loading-progress-fill").style.width).toBe("37.4%");
    expect(byId("loading-progress-pct").textContent).toBe("37%");
    expect(byId("loading-progress").getAttribute("aria-valuenow")).toBe("37");
    expect(byId("status").textContent).toBe("Downloading the app");
    expect(byId("status").style.opacity).toBe("0.8");
    expect(byId("status-sr").textContent).toBe("Downloading the app");
    expect(byId("loading-warning").classList.contains("visible")).toBe(true);
    expect(byId("loading-warning-text").textContent).toBe(
      "Still looking for peers",
    );
    await settle();
    expect(getLoadingState()).toEqual(before);
  });

  it("As a visitor, the loading screen follows the store", async () => {
    // Given
    mountLoadingIsland();
    await settle();

    // When
    updateLoading({
      progress: 62.6,
      statusText: "Connecting to",
      statusOpacity: 0.9,
      srText: "Connecting to Polkadot",
      warning: "Slow <b>peers</b>",
    });
    await settle();

    // Then
    expect(byId("loading-progress-fill").style.width).toBe("62.6%");
    expect(byId("loading-progress-pct").textContent).toBe("63%");
    expect(byId("loading-progress").getAttribute("aria-valuenow")).toBe("63");
    expect(byId("status").textContent).toBe("Connecting to");
    expect(byId("status").style.opacity).toBe("0.9");
    expect(byId("status-sr").textContent).toBe("Connecting to Polkadot");
    const warning = byId("loading-warning");
    expect(warning.classList.contains("visible")).toBe(true);
    expect(warning.classList.contains("loading-warning")).toBe(true);
    // A warning is text, never markup.
    expect(byId("loading-warning-text").textContent).toBe("Slow <b>peers</b>");
    expect(warning.querySelector("b")).toBeNull();

    // When
    updateLoading({ warning: null });
    await settle();

    // Then
    expect(warning.classList.contains("visible")).toBe(false);
    expect(byId("loading-warning-text").textContent).toBe("");
  });

  it("As a visitor whose app loaded, the loading screen fades, then goes after 300 ms with its root", async () => {
    // Given
    ctl.initPhases([
      { label: "a", base: 0, target: 50, expectedMs: 5_000, stage: "relay" },
    ]);
    ctl.advancePhase(0);
    mountLoadingIsland();
    await settle();
    const screen = byId("app-loading");

    // When
    ctl.dismissLoading();
    await settle();

    // Then
    expect(screen.style.transition).toBe("opacity 0.3s ease");
    expect(screen.style.opacity).toBe("0");
    expect(screen.style.pointerEvents).toBe("none");
    expect(byId("loading-progress-pct").textContent).toBe("100%");
    expect(screen.isConnected).toBe(true);

    // When
    vi.advanceTimersByTime(FADE_MS - 1);
    await settle();

    // Then
    expect(screen.isConnected).toBe(true);

    // When
    vi.advanceTimersByTime(1);
    await settle();

    // Then the node is gone and the island no longer follows the store
    expect(screen.isConnected).toBe(false);
    expect(document.getElementById("app-loading")).toBeNull();
    expect(getLoadingState().phase).toBe("gone");
    updateLoading({ statusText: "late line" });
    await settle();
    expect(screen.querySelector("#status")?.textContent).not.toBe("late line");
    expect(frames.size).toBe(0);
  });

  it("As a visitor whose load failed, the error page disposes the loading screen and its timers", async () => {
    // Given a crawling bar under the live screen
    ctl.initPhases([
      { label: "a", base: 5, target: 90, expectedMs: 60_000, stage: "relay" },
    ]);
    ctl.advancePhase(0);
    mountLoadingIsland();
    await settle();
    const screen = byId("app-loading");
    runFrames(100);
    // The typewriter's next frame.
    expect(frames.size).toBe(1);

    // When
    showErrorPage({ title: "Failed" });
    const frozen = getLoadingState().progress;
    vi.advanceTimersByTime(10_000);
    await settle();

    // Then
    expect(screen.isConnected).toBe(false);
    expect(getLoadingState().phase).toBe("gone");
    expect(getLoadingState().progress).toBe(frozen);
    expect(frames.size).toBe(0);
    expect(document.querySelector(".error-page-title")?.textContent).toBe(
      "Failed",
    );
  });

  it("As a visitor, the landing page disposes a loading screen mounted before it", async () => {
    // Given
    mountLoadingIsland();
    await settle();
    const screen = byId("app-loading");
    runFrames(100);

    // When
    await showLanding();
    await settle();

    // Then
    expect(screen.isConnected).toBe(false);
    expect(getLoadingState().phase).toBe("gone");
    expect(frames.size).toBe(0);
  });

  it("As a visitor, the petals are animated by the stylesheet alone, with no frames or inline styles", async () => {
    // When
    mountLoadingIsland();
    await settle();
    runFrames(100);

    // Then
    expect(petals()).toHaveLength(6);
    expect(petals().every((p) => !p.hasAttribute("style"))).toBe(true);
    expect(frames.size).toBe(0);
  });

  it("As a visitor, the petals of the static and the live loading screen light up in turn, a sixth of a cycle apart, and stay still under reduced motion", async () => {
    // Given
    mountLoadingIsland();
    await settle();
    const screens = {
      static: staticLoadingMarkup(),
      live: byId("app-loading").outerHTML,
    };

    for (const [name, markup] of Object.entries(screens)) {
      // When: no motion preference.
      const moving = await petalAnimations(markup, "no-preference");

      // Then
      expect(moving, name).toHaveLength(6);
      for (const [i, petal] of moving.entries()) {
        expect(petal.animation, `${name} petal ${String(i)}`).toMatch(
          /^loading-petal \S+ .*infinite$/,
        );
        const cycleMs = toMs(nth(petal.animation.split(" "), 1));
        const offset = ((petal.delayMs % cycleMs) + cycleMs) % cycleMs;
        expect(offset, `${name} petal ${String(i)}`).toBeCloseTo(
          (i * cycleMs) / 6,
          2,
        );
      }

      // When: reduced motion.
      const still = await petalAnimations(markup, "reduce");

      // Then
      expect(
        still.map((petal) => petal.animation),
        name,
      ).toEqual(Array(6).fill(""));
    }
  });

  it("As the shell, disposing the loading root stops the loading timers along with the island", async () => {
    // Given
    const onStall = vi.fn();
    ctl.initPhases([
      {
        label: "a",
        base: 10,
        target: 90,
        expectedMs: 10_000,
        stage: "content",
        reportsProgress: true,
      },
    ]);
    ctl.onProgressStall(onStall);
    ctl.advancePhase(0);
    mountLoadingIsland();
    await settle();
    const screen = byId("app-loading");

    // When
    disposeAppRoot("loading");
    vi.advanceTimersByTime(20_000);

    // Then
    expect(screen.isConnected).toBe(false);
    expect(onStall).not.toHaveBeenCalled();
    expect(getLoadingState().phase).toBe("gone");
  });

  it("As the shell, mounting the island does not dispose the running load", async () => {
    // Given a crawling bar
    ctl.initPhases([
      { label: "a", base: 5, target: 90, expectedMs: 10_000, stage: "relay" },
    ]);
    ctl.advancePhase(0);

    // When
    mountLoadingIsland();
    const before = getLoadingState().progress;
    vi.advanceTimersByTime(1_000);
    await settle();

    // Then the crawl goes on, into the live screen
    expect(getLoadingState().phase).toBe("active");
    expect(getLoadingState().progress).toBeGreaterThan(before);
    expect(byId("loading-progress-pct").textContent).toBe(
      `${String(Math.round(getLoadingState().progress))}%`,
    );
  });

  it("As the shell, the first app-subdomain render keeps the live screen and it still follows the store", async () => {
    // Given
    mountLoadingIsland();
    await settle();

    // When the bridge clears `#app` and puts the overlay back, as
    // renderAppSubdomain does on its first render
    const loading = app().querySelector<HTMLElement>(".loading");
    app().innerHTML = "";
    if (loading !== null) {
      app().appendChild(loading);
    }
    updateLoading({ progress: 80 });
    await settle();

    // Then it found the island's node, which is still live
    expect(loading).toBe(byId("app-loading"));
    expect(byId("loading-progress-pct").textContent).toBe("80%");
  });

  it.each([
    [
      "the static screen is already gone",
      () => {
        app().innerHTML = `<div class="error-page"></div>`;
      },
    ],
    [
      "the loading root was already disposed",
      () => {
        updateLoading({ phase: "gone" });
      },
    ],
  ])(
    "As the shell, no loading screen is mounted when %s",
    async (_name, given) => {
      // Given
      given();
      const markup = app().innerHTML;
      const dispose = vi.fn();
      registerAppRoot("page", dispose);

      // When
      const mounted = mountLoadingIsland();
      await settle();

      // Then it did not fail, and nothing changed
      expect(mounted).toBe(true);
      expect(app().innerHTML).toBe(markup);
      expect(frames.size).toBe(0);
      expect(dispose).not.toHaveBeenCalled();
      expect(sentry.captureException).not.toHaveBeenCalled();
    },
  );
});
