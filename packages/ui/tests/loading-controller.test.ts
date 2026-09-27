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
      <div class="loading">
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

  it("As the shell, a bar restarted after the loading root was disposed is tracked again", async () => {
    // Given
    ctl.initPhases([
      { label: "a", base: 5, target: 50, expectedMs: 60_000, stage: "relay" },
      { label: "b", base: 50, target: 90, expectedMs: 60_000, stage: "relay" },
    ]);
    ctl.advancePhase(0);
    const roots = await import("@dotli/ui/mount/app-roots");
    roots.disposeAppRoot("loading");

    // When a late signal starts the crawl again, and the root is disposed
    ctl.advancePhase(1);
    roots.disposeAppRoots();
    const frozen = progress();
    vi.advanceTimersByTime(10_000);

    // Then the crawl stopped with it
    expect(progress()).toBe(frozen);
  });

  it("As a visitor, the interim renderer draws the store into the loading markup", () => {
    // Given
    reducedMotion = true;
    ctl.initPhases([
      { label: "a", base: 42, target: 50, expectedMs: 5_000, stage: "relay" },
    ]);

    // When
    ctl.advancePhase(0);
    ctl.setLoadingWarning("Slow <b>peers</b>");

    // Then
    const pct = document.getElementById("loading-progress-pct");
    expect(document.getElementById("loading-progress-fill")?.style.width).toBe(
      "42%",
    );
    expect(pct?.textContent).toBe("42%");
    expect(
      document
        .getElementById("loading-progress")
        ?.getAttribute("aria-valuenow"),
    ).toBe("42");
    expect(document.getElementById("status")?.textContent).toBe(
      "Connecting to Polkadot",
    );
    expect(document.getElementById("status-sr")?.textContent).toBe(
      "Connecting to Polkadot",
    );
    const warning = document.getElementById("loading-warning");
    expect(warning?.classList.contains("visible")).toBe(true);
    expect(document.getElementById("loading-warning-text")?.textContent).toBe(
      "Slow <b>peers</b>",
    );
    expect(warning?.querySelector("b")).toBeNull();

    // When
    ctl.setLoadingWarning(null);

    // Then
    expect(warning?.classList.contains("visible")).toBe(false);
    expect(document.getElementById("loading-warning-text")?.textContent).toBe(
      "",
    );
  });

  it("As a visitor, the interim renderer fades the overlay and removes it after 300 ms", () => {
    // Given
    const loading = document.querySelector<HTMLElement>("#app > .loading");

    // When
    ctl.dismissLoading();

    // Then
    expect(loading?.style.opacity).toBe("0");
    expect(loading?.style.pointerEvents).toBe("none");
    expect(loading?.style.transition).toBe("opacity 0.3s ease");
    expect(loading?.isConnected).toBe(true);

    // When
    vi.advanceTimersByTime(FADE_MS);

    // Then
    expect(loading?.isConnected).toBe(false);
  });
});
