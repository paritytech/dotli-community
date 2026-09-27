// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LoadingPhase } from "@dotli/ui/ui";

type Ui = typeof import("@dotli/ui/ui");
type AppRoots = typeof import("@dotli/ui/mount/app-roots");

// Mirror of PROGRESS_STALL_MS in ui.ts.
const STALL_MS = 4_000;

// One long clock-driven band, so the crawl moves the bar on every tick.
const PHASES: LoadingPhase[] = [
  {
    label: "Connecting",
    base: 5,
    target: 90,
    expectedMs: 60_000,
    stage: "relay",
  },
];

function installLoadingDom(): void {
  document.body.innerHTML = `
    <div id="app">
      <div class="loading">
        <div class="loading-progress" id="loading-progress">
          <div class="loading-progress-fill" id="loading-progress-fill"></div>
          <span class="loading-progress-pct" id="loading-progress-pct">0%</span>
        </div>
        <p id="status"></p>
        <p class="sr-only" id="status-sr"></p>
      </div>
    </div>`;
}

describe("The loading screen is a tracked app root", () => {
  let ui: Ui;
  let roots: AppRoots;

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    installLoadingDom();
    // `ui.ts` binds `#app` when it loads, so it loads after the fixture.
    [ui, roots] = await Promise.all([
      import("@dotli/ui/ui"),
      import("@dotli/ui/mount/app-roots"),
    ]);
  });

  afterEach(() => {
    roots.disposeAppRoots();
    vi.useRealTimers();
  });

  /** Start a load whose bar is crawling and whose stall watch is armed. */
  function startLoading(onStall: (pct: number) => void): HTMLElement {
    const fill = document.getElementById("loading-progress-fill");
    if (fill === null) {
      throw new Error("fixture has no progress fill");
    }
    ui.initPhases(PHASES);
    ui.onProgressStall(onStall);
    ui.advancePhase(0);
    // Prove the crawl really is running before anything stops it.
    const before = fill.style.width;
    vi.advanceTimersByTime(1_000);
    expect(fill.style.width).not.toBe(before);
    return fill;
  }

  it("As a visitor whose name has no content, the loading bar stops ticking behind the error", () => {
    // Given
    const onStall = vi.fn();
    const fill = startLoading(onStall);

    // When
    ui.showNoContentError("nothing");
    const frozen = fill.style.width;
    vi.advanceTimersByTime(STALL_MS * 5);

    // Then no crawl tick and no stall report lands after the error
    expect(fill.style.width).toBe(frozen);
    expect(onStall).not.toHaveBeenCalled();
    expect(document.querySelector(".error-page-title")?.textContent).toBe(
      "This app can't be reached",
    );
  });

  it("As a visitor whose load failed, the loading bar stops ticking behind the error", () => {
    // Given
    const onStall = vi.fn();
    const fill = startLoading(onStall);

    // When
    ui.showErrorPage({ title: "Failed" });
    const frozen = fill.style.width;
    vi.advanceTimersByTime(STALL_MS * 5);

    // Then
    expect(fill.style.width).toBe(frozen);
    expect(onStall).not.toHaveBeenCalled();
  });

  it("As the shell, an error page disposes the page and loading roots before it replaces #app", () => {
    // Given
    const seen: string[] = [];
    const record = (name: string) => () => {
      // Disposal comes first, while the old content is still in place.
      expect(document.querySelector(".error-page")).toBeNull();
      seen.push(name);
    };
    roots.registerAppRoot("page", record("page"));
    roots.registerAppRoot("loading", record("loading"));

    // When
    ui.showErrorPage({ title: "Failed" });

    // Then
    expect(seen.sort()).toEqual(["loading", "page"]);
    expect(document.querySelector(".error-page")).not.toBeNull();
  });

  it("As the shell, the no-content page disposes the page and loading roots before it replaces #app", () => {
    // Given
    const seen: string[] = [];
    const record = (name: string) => () => {
      expect(document.querySelector(".error-page")).toBeNull();
      seen.push(name);
    };
    roots.registerAppRoot("page", record("page"));
    roots.registerAppRoot("loading", record("loading"));

    // When
    ui.showNoContentError("nothing");

    // Then
    expect(seen.sort()).toEqual(["loading", "page"]);
    expect(document.querySelector(".error-page")).not.toBeNull();
  });

  it("As the shell, disposing the loading root stops its timers and removes the overlay", () => {
    // Given
    const onStall = vi.fn();
    const fill = startLoading(onStall);
    const loading = document.querySelector("#app > .loading");

    // When
    roots.disposeAppRoot("loading");
    const frozen = fill.style.width;
    vi.advanceTimersByTime(STALL_MS * 5);

    // Then
    expect(loading?.isConnected).toBe(false);
    expect(fill.style.width).toBe(frozen);
    expect(onStall).not.toHaveBeenCalled();
  });

  it("As the shell, starting the loading phases again keeps the overlay on screen", () => {
    // Given
    ui.initPhases(PHASES);
    const loading = document.querySelector("#app > .loading");

    // When
    ui.initPhases(PHASES);

    // Then
    expect(loading?.isConnected).toBe(true);

    // When
    roots.disposeAppRoot("loading");

    // Then
    expect(loading?.isConnected).toBe(false);
  });
});
