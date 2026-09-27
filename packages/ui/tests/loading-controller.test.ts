// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LoadingPhase } from "@dotli/ui/loading-controller";

type Controller = typeof import("@dotli/ui/loading-controller");
type LoadingStateModule = typeof import("@dotli/ui/state/loading");

// Mirrors of the constants in loading-controller.ts.
const STALL_MS = 4_000;
const ROTATE_MS = 9_000;
const ERASE_MS = 1_400;
const TYPE_MS = 3_600;
const FADE_MS = 300;

const SANDBOX_ORIGIN = "http://myapp.app.localhost:5173";

let reducedMotion = false;

function stubMotionPreference(): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(prefers-reduced-motion: reduce)" && reducedMotion,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

function installLoadingDom(): void {
  document.body.innerHTML = `
    <div id="app">
      <div class="loading" id="app-loading">
        <div class="loading-progress" id="loading-progress" aria-valuenow="0">
          <div class="loading-progress-fill" id="loading-progress-fill"></div>
          <span class="loading-progress-pct" id="loading-progress-pct">0%</span>
        </div>
        <p id="status" aria-hidden="true">Reaching out</p>
        <p class="sr-only" id="status-sr" aria-live="polite"></p>
        <p class="loading-warning" id="loading-warning" role="status">
          <span id="loading-warning-text"></span>
        </p>
      </div>
    </div>`;
}

describe("The loading controller drives the loading store", () => {
  let ctl: Controller;
  let store: LoadingStateModule;

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    reducedMotion = false;
    stubMotionPreference();
    installLoadingDom();
    [ctl, store] = await Promise.all([
      import("@dotli/ui/loading-controller"),
      import("@dotli/ui/state/loading"),
    ]);
  });

  afterEach(async () => {
    const roots = await import("@dotli/ui/mount/app-roots");
    roots.disposeAppRoots();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const progress = (): number => store.getLoadingState().progress;
  const status = (): string => store.getLoadingState().statusText;

  /** Every distinct headline the store held, in order. */
  function recordHeadlines(): string[] {
    const seen: string[] = [status()];
    store.loadingStore.subscribe(() => {
      const text = status();
      if (text !== seen[seen.length - 1]) {
        seen.push(text);
      }
    });
    return seen;
  }

  it("As a visitor, the bar crawls across a step in about its expected time, then creeps into the next step's headroom", () => {
    // Given one 10s step followed by a step reaching 60
    const phases: LoadingPhase[] = [
      { label: "a", base: 0, target: 40, expectedMs: 10_000, stage: "relay" },
      {
        label: "b",
        base: 40,
        target: 60,
        expectedMs: 5_000,
        stage: "assetHub",
      },
    ];
    ctl.initPhases(phases);

    // When
    ctl.advancePhase(0);
    vi.advanceTimersByTime(5_000);

    // Then about halfway across the band
    expect(progress()).toBeGreaterThan(15);
    expect(progress()).toBeLessThan(25);

    // When the step overruns its expected time
    vi.advanceTimersByTime(5_000);

    // Then the crawl has reached the band's target
    expect(progress()).toBeCloseTo(40, 5);

    // When it keeps overrunning
    vi.advanceTimersByTime(60_000);

    // Then it has crept into the next band, but never past its target
    expect(progress()).toBeGreaterThan(40);
    expect(progress()).toBeLessThanOrEqual(60);
  });

  it("As a visitor, the creep stops short of a full bar on the last step", () => {
    // Given
    ctl.initPhases([
      { label: "a", base: 0, target: 90, expectedMs: 1_000, stage: "content" },
    ]);

    // When
    ctl.advancePhase(0);
    vi.advanceTimersByTime(10 * 60_000);

    // Then
    expect(progress()).toBe(99);
  });

  it("As a visitor, the headline rotation never repeats a step's opening line", () => {
    // Given
    reducedMotion = true;
    const seen = recordHeadlines();

    // When
    ctl.setLoadingStage("relay");
    vi.advanceTimersByTime(ROTATE_MS * 10);

    // Then
    expect(seen.filter((s) => s === "Connecting to Polkadot")).toHaveLength(1);
    expect(seen.slice(1)).toEqual([
      "Connecting to Polkadot",
      "Looking for other computers to talk to",
      "Your browser does the checking itself, not a server",
      "Looking for other computers to talk to",
      "Your browser does the checking itself, not a server",
      "Looking for other computers to talk to",
      "Your browser does the checking itself, not a server",
      "Looking for other computers to talk to",
      "Your browser does the checking itself, not a server",
      "Looking for other computers to talk to",
      "Your browser does the checking itself, not a server",
    ]);
  });

  it("As a visitor, the headline types in frame by frame", () => {
    // Given
    const seen = recordHeadlines();

    // When
    ctl.setLoadingStage("relay");
    vi.advanceTimersByTime(ERASE_MS + TYPE_MS + 100);

    // Then the old line was erased and the new one typed a piece at a time
    expect(seen).toContain("Reach");
    expect(seen).toContain("Conn");
    expect(status()).toBe("Connecting to Polkadot");
    expect(store.getLoadingState().statusOpacity).toBe(1);
  });

  it("As a visitor on a quick load, only the newest waiting line is typed after the current one", () => {
    // Given
    const seen = recordHeadlines();
    ctl.setLoadingDomain("myapp");
    ctl.setLoadingStage("relay");

    // When two more stages land while the first line is still typing
    vi.advanceTimersByTime(500);
    ctl.setLoadingStage("assetHub");
    ctl.setLoadingStage("resolving");

    // Then the screen reader hears the newest at once
    expect(store.getLoadingState().srText).toBe("Found it");

    // When both lines have had time to type
    vi.advanceTimersByTime(2 * (ERASE_MS + TYPE_MS));

    // Then the running line finished, then the newest, and the skipped one
    // never showed
    const running = seen.indexOf("Connecting to Polkadot");
    expect(running).toBeGreaterThan(0);
    expect(seen.indexOf("Found it")).toBeGreaterThan(running);
    expect(seen.some((s) => s.startsWith("Looking up"))).toBe(false);
  });

  it("As a visitor who prefers reduced motion, the headline changes at once", () => {
    // Given
    reducedMotion = true;

    // When
    ctl.setLoadingStage("relay");

    // Then
    expect(status()).toBe("Connecting to Polkadot");
    expect(store.getLoadingState().srText).toBe("Connecting to Polkadot");
  });

  it("As a visitor whose load parked, the stall watch fires with the percentage", () => {
    // Given
    const onStall = vi.fn();
    ctl.initPhases([
      {
        label: "Fetching content",
        base: 10,
        target: 90,
        expectedMs: 10_000,
        stage: "content",
        reportsProgress: true,
      },
    ]);
    ctl.onProgressStall(onStall);

    // When
    ctl.advancePhase(0);
    vi.advanceTimersByTime(STALL_MS + 100);

    // Then
    expect(onStall).toHaveBeenCalledTimes(1);
    expect(onStall).toHaveBeenCalledWith(10);
  });

  it("As a visitor, a stall warning is shown and cleared", () => {
    // When
    ctl.setLoadingWarning("Still looking for peers");

    // Then
    expect(store.getLoadingState().warning).toBe("Still looking for peers");

    // When
    ctl.setLoadingWarning(null);

    // Then
    expect(store.getLoadingState().warning).toBeNull();
  });

  it("As a visitor whose app loaded, the loading screen fills, fades, then goes after 300 ms", () => {
    // Given
    ctl.initPhases([
      { label: "a", base: 0, target: 50, expectedMs: 5_000, stage: "relay" },
    ]);
    ctl.advancePhase(0);

    // When
    ctl.dismissLoading();

    // Then
    expect(store.getLoadingState().phase).toBe("dismissing");
    expect(progress()).toBe(100);

    // When
    vi.advanceTimersByTime(FADE_MS - 1);

    // Then
    expect(store.getLoadingState().phase).toBe("dismissing");

    // When
    vi.advanceTimersByTime(1);

    // Then
    expect(store.getLoadingState().phase).toBe("gone");
  });

  it("As a visitor, the sandbox's done message dismisses the loading screen and runs the done callbacks", () => {
    // Given
    const onDone = vi.fn();
    ctl.listenForSandboxStatus();
    ctl.onSandboxDone(onDone);

    // When
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "dotli:loading-status", done: true },
        origin: SANDBOX_ORIGIN,
      }),
    );

    // Then
    expect(store.getLoadingState().phase).toBe("dismissing");
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("As a visitor, a done message from any other origin is ignored", () => {
    // Given
    const onDone = vi.fn();
    ctl.listenForSandboxStatus();
    ctl.onSandboxDone(onDone);

    // When
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "dotli:loading-status", done: true },
        origin: "https://attacker.example",
      }),
    );

    // Then
    expect(store.getLoadingState().phase).toBe("active");
    expect(onDone).not.toHaveBeenCalled();
  });

  it("As the shell, disposing the loading root stops every loading timer and marks the screen gone", async () => {
    // Given a crawling bar, a rotating headline and an armed stall watch
    const onStall = vi.fn();
    ctl.initPhases([
      { label: "a", base: 5, target: 90, expectedMs: 60_000, stage: "relay" },
    ]);
    ctl.onProgressStall(onStall);
    ctl.advancePhase(0);
    vi.advanceTimersByTime(1_000);
    const roots = await import("@dotli/ui/mount/app-roots");

    // When
    roots.disposeAppRoot("loading");
    const frozen = store.getLoadingState();
    vi.advanceTimersByTime(ROTATE_MS * 5);

    // Then
    expect(frozen.phase).toBe("gone");
    expect(store.getLoadingState()).toEqual(frozen);
    expect(onStall).not.toHaveBeenCalled();
  });

  it("As the shell, a late signal after the loading root was disposed starts no timer", async () => {
    // Given a load whose screen has gone
    ctl.initPhases([
      { label: "a", base: 5, target: 50, expectedMs: 60_000, stage: "relay" },
      {
        label: "b",
        base: 50,
        target: 90,
        expectedMs: 60_000,
        stage: "content",
      },
    ]);
    ctl.advancePhase(0);
    const roots = await import("@dotli/ui/mount/app-roots");
    roots.disposeAppRoot("loading");
    expect(vi.getTimerCount()).toBe(0);

    // When late signals arrive: content bytes, a progress fraction and a
    // phase change
    ctl.setLoadingStage("preparing");
    ctl.advancePhase(1);
    ctl.nudgePhaseProgress(0.5, "content");

    // Then no rotation, typing frame, crawl or stall watch was started
    expect(vi.getTimerCount()).toBe(0);
    expect(store.getLoadingState().phase).toBe("gone");
  });

  it("As the shell, the static screen is the loading root from the moment the controller loads", async () => {
    // Given a controller that has started nothing
    const stopSpinner = vi.fn();
    window.__stopLoadingSpinner = stopSpinner;
    const screen = document.getElementById("app-loading");
    const roots = await import("@dotli/ui/mount/app-roots");

    // When whatever replaces the screen disposes the roots
    roots.disposeAppRoots();

    // Then the spinner stopped and the static screen went with it
    expect(stopSpinner).toHaveBeenCalledTimes(1);
    expect(screen?.isConnected).toBe(false);
    expect(store.getLoadingState().phase).toBe("gone");
    expect(vi.getTimerCount()).toBe(0);
    delete window.__stopLoadingSpinner;
  });

  it("As the shell, starting the phases keeps the root the controller registered on load", async () => {
    // Given
    const stopSpinner = vi.fn();
    window.__stopLoadingSpinner = stopSpinner;
    const screen = document.getElementById("app-loading");

    // When
    ctl.initPhases([
      { label: "a", base: 5, target: 90, expectedMs: 60_000, stage: "relay" },
    ]);
    ctl.advancePhase(0);

    // Then the screen is still up and the load is running
    expect(screen?.isConnected).toBe(true);
    expect(stopSpinner).not.toHaveBeenCalled();
    expect(store.getLoadingState().phase).toBe("active");

    // When
    const roots = await import("@dotli/ui/mount/app-roots");
    roots.disposeAppRoot("loading");

    // Then one root, disposed once
    expect(stopSpinner).toHaveBeenCalledTimes(1);
    expect(screen?.isConnected).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    delete window.__stopLoadingSpinner;
  });

  it("As the shell, a page without the static screen gets no loading root when the controller loads", async () => {
    // Given a page with no static screen, such as the sandbox's
    vi.resetModules();
    document.body.innerHTML = `<div id="app"></div>`;
    const [fresh, freshStore, roots] = await Promise.all([
      import("@dotli/ui/loading-controller"),
      import("@dotli/ui/state/loading"),
      import("@dotli/ui/mount/app-roots"),
    ]);
    const stopSpinner = vi.fn();
    window.__stopLoadingSpinner = stopSpinner;

    // When
    roots.disposeAppRoots();

    // Then nothing was registered to dispose
    expect(stopSpinner).not.toHaveBeenCalled();
    expect(freshStore.getLoadingState().phase).toBe("active");
    expect(fresh.LOADING_STAGES).toContain("starting");
    delete window.__stopLoadingSpinner;
  });

  it("As a visitor whose app loaded, the dismiss stops the headline rotation and the typing", () => {
    // Given a headline mid-turn
    ctl.initPhases([
      { label: "a", base: 5, target: 90, expectedMs: 60_000, stage: "relay" },
    ]);
    ctl.advancePhase(0);
    vi.advanceTimersByTime(ROTATE_MS + ERASE_MS / 2);
    const midTurn = status();

    // When
    ctl.dismissLoading();
    vi.advanceTimersByTime(FADE_MS);

    // Then nothing is left running and the line no longer changes
    expect(store.getLoadingState().phase).toBe("gone");
    expect(vi.getTimerCount()).toBe(0);
    const settled = status();
    vi.advanceTimersByTime(ROTATE_MS * 3);
    expect(status()).toBe(settled);
    expect(store.getLoadingState().statusOpacity).toBe(1);
    expect(midTurn).not.toBe("");
  });

  it("As a visitor, a second done message from the sandbox runs the done callbacks only once", () => {
    // Given
    const onDone = vi.fn();
    ctl.listenForSandboxStatus();
    ctl.onSandboxDone(onDone);
    const done = (): void => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { type: "dotli:loading-status", done: true },
          origin: SANDBOX_ORIGIN,
        }),
      );
    };
    done();
    vi.advanceTimersByTime(FADE_MS);

    // When
    done();

    // Then
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(store.getLoadingState().phase).toBe("gone");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("As the shell, disposing the loading root before the island mounts removes the static screen and stops its spinner", async () => {
    // Given
    const stopSpinner = vi.fn();
    window.__stopLoadingSpinner = stopSpinner;
    ctl.initPhases([
      { label: "a", base: 5, target: 90, expectedMs: 60_000, stage: "relay" },
    ]);
    const screen = document.getElementById("app-loading");
    const roots = await import("@dotli/ui/mount/app-roots");

    // When
    roots.disposeAppRoot("loading");

    // Then
    expect(screen?.isConnected).toBe(false);
    expect(stopSpinner).toHaveBeenCalledTimes(1);
    delete window.__stopLoadingSpinner;
  });

  it("As a visitor whose app loaded before the island mounted, the static screen goes after 300 ms", () => {
    // Given
    const screen = document.getElementById("app-loading");

    // When
    ctl.dismissLoading();
    vi.advanceTimersByTime(FADE_MS - 1);

    // Then
    expect(screen?.isConnected).toBe(true);

    // When
    vi.advanceTimersByTime(1);

    // Then
    expect(screen?.isConnected).toBe(false);
    expect(store.getLoadingState().phase).toBe("gone");
  });

  it("As the shell, a screen the island adopted is disposed with the loading root, timers and all", async () => {
    // Given a crawling bar
    ctl.initPhases([
      { label: "a", base: 5, target: 90, expectedMs: 60_000, stage: "relay" },
    ]);
    ctl.advancePhase(0);
    const disposeScreen = vi.fn();

    // When the island takes the screen over
    ctl.adoptLoadingScreen(disposeScreen);
    const before = progress();
    vi.advanceTimersByTime(1_000);

    // Then nothing was disposed and the load goes on
    expect(disposeScreen).not.toHaveBeenCalled();
    expect(store.getLoadingState().phase).toBe("active");
    expect(progress()).toBeGreaterThan(before);

    // When
    const roots = await import("@dotli/ui/mount/app-roots");
    roots.disposeAppRoot("loading");
    const frozen = progress();
    vi.advanceTimersByTime(10_000);

    // Then the island's dispose ran instead of the static fallback
    expect(disposeScreen).toHaveBeenCalledTimes(1);
    expect(document.getElementById("app-loading")?.isConnected).toBe(true);
    expect(progress()).toBe(frozen);
    expect(store.getLoadingState().phase).toBe("gone");

    // When a late signal restarts a timer, the root is the static fallback
    // again and never the disposed island
    ctl.releasePhaseProgress();
    ctl.setLoadingStage("content");
    roots.disposeAppRoot("loading");

    // Then
    expect(disposeScreen).toHaveBeenCalledTimes(1);
  });
});
