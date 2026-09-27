// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The loading screen island (components/shell/LoadingScreen.tsx) swapped in
// for the static `.loading` markup of apps/host/index.html, rendering the
// loading store the controller writes.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { flush } from "solid-js";

// ui.ts binds `#app` when it loads, so the element exists before any import
// runs and every test only ever replaces its children.
vi.hoisted(() => {
  document.body.innerHTML = `<div id="app"></div>`;
});

const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock("@dotli/metrics/sentry", () => sentry);
// The landing page loads the recent names from the shared storage frame,
// which happy-dom would try to fetch.
vi.mock("@dotli/ui/recent-labels", () => ({
  loadRecentLabels: () => Promise.resolve([]),
  forgetRecentLabel: () => Promise.resolve(),
}));

import {
  mountIslands,
  mountLoadingIsland,
} from "@dotli/ui/components/shell/islands";
import * as ctl from "@dotli/ui/loading-controller";
import {
  disposeAppRoot,
  disposeAppRoots,
  registerAppRoot,
} from "@dotli/ui/mount/app-roots";
import { disposeRoot } from "@dotli/ui/mount/root";
import { resetAllStoresForTests } from "@dotli/ui/state/create-store";
import { getLoadingState, updateLoading } from "@dotli/ui/state/loading";
import { showErrorPage } from "@dotli/ui/ui";
import { showLanding } from "@dotli/ui/landing/load";

const INDEX_HTML = readFileSync(
  resolve(import.meta.dirname, "../../../../../apps/host/index.html"),
  "utf8",
);

/** The static loading screen exactly as apps/host/index.html ships it. */
function staticLoadingMarkup(): string {
  // Only `#app`, up to the inline spinner script after it: parsing the whole
  // page would make happy-dom fetch its scripts and stylesheets.
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

let reducedMotion = false;
let frames: Map<number, FrameRequestCallback>;
let nextFrame = 0;
let stopStaticSpinner: ReturnType<typeof vi.fn>;

/** Run every animation frame requested so far, at `now`. */
function runFrames(now: number): void {
  const due = [...frames];
  frames.clear();
  for (const [, cb] of due) {
    cb(now);
  }
}

function app(): HTMLElement {
  return document.getElementById("app") as HTMLElement;
}

function byId(id: string): HTMLElement {
  return document.getElementById(id) as HTMLElement;
}

function countById(id: string): number {
  return document.querySelectorAll(`[id="${id}"]`).length;
}

function petals(root: ParentNode = document): SVGPathElement[] {
  return [...root.querySelectorAll<SVGPathElement>(".loading-petal")];
}

async function settle(): Promise<void> {
  flush();
  await Promise.resolve();
  flush();
}

/**
 * `el` as tag, attributes (sorted) and children, without what the store and
 * the spinner write as they go (inline styles) and without comments and
 * whitespace, so static and live markup compare node for node.
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
  reducedMotion = false;
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(prefers-reduced-motion: reduce)" && reducedMotion,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  frames = new Map();
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    nextFrame += 1;
    frames.set(nextFrame, cb);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    frames.delete(id);
  });
  stopStaticSpinner = vi.fn();
  window.__stopLoadingSpinner = stopStaticSpinner as () => void;
  app().innerHTML = staticLoadingMarkup();
  sentry.captureException.mockClear();
});

afterEach(() => {
  disposeAppRoots();
  disposeRoot("island:loading");
  ctl.stopStatusTick();
  resetAllStoresForTests();
  app().innerHTML = "";
  delete window.__stopLoadingSpinner;
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
      "user-popover",
      "auth-modal",
      "permissions",
      "chains",
      "settings",
      "more",
    ]) {
      disposeRoot(`island:${name}`);
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
    // The spinner's next frame and the typewriter's.
    expect(frames.size).toBe(2);

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

  it("As a visitor, the petals cycle once the island takes over, and stop when it is disposed", async () => {
    // Given
    mountLoadingIsland();
    await settle();

    // Then the inline spinner no longer drives the static petals
    expect(stopStaticSpinner).toHaveBeenCalledTimes(1);

    // When
    runFrames(1_000);
    runFrames(1_350);

    // Then the petals light up in turn, on the inline spinner's curve: 350 ms
    // into the 1400 ms cycle, petal 1 is lit and petal 0 is back at its floor.
    const live = petals();
    const lit = (1 - 2.5 * (0.25 - 1 / 6)) ** 2;
    expect(Number(live[1].style.opacity)).toBeCloseTo(lit, 5);
    expect(live[1].style.transform).toMatch(/^scale\(0\.97/);
    expect(Number(live[0].style.opacity)).toBeCloseTo(0.15, 5);
    expect(live[0].style.transform).toMatch(/^scale\(0\.93/);
    expect(frames.size).toBe(1);

    // When
    disposeAppRoot("loading");

    // Then
    expect(frames.size).toBe(0);
    expect(live[0].isConnected).toBe(false);
  });

  it("As a visitor who prefers reduced motion, the petals stay still", async () => {
    // Given
    reducedMotion = true;

    // When
    mountLoadingIsland();
    await settle();

    // Then
    expect(frames.size).toBe(0);
    expect(petals().every((p) => !p.hasAttribute("style"))).toBe(true);
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
      expect(stopStaticSpinner).not.toHaveBeenCalled();
      expect(frames.size).toBe(0);
      expect(dispose).not.toHaveBeenCalled();
      expect(sentry.captureException).not.toHaveBeenCalled();
    },
  );
});
