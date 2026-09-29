// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LoadingPhase } from "../src/loading-controller.js";
import type * as UiModule from "../src/ui.js";
import type * as LoadingControllerModule from "../src/loading-controller.js";
import type * as AppRootsModule from "../src/mount/app-roots.js";
import type * as LoadingModule from "../src/state/loading.js";

const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock("../../metrics/src/sentry.js", () => sentry);

type Ui = typeof UiModule;
type Controller = typeof LoadingControllerModule;
type AppRoots = typeof AppRootsModule;
type LoadingState = typeof LoadingModule;

// Mirror of PROGRESS_STALL_MS in loading-controller.ts.
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

// A band that waits for a real percentage, so the bar parks at its base and
// the stall watch fires unless something stops it.
const PARKED_PHASES: LoadingPhase[] = [
  {
    label: "Fetching content",
    base: 10,
    target: 90,
    expectedMs: 10_000,
    stage: "content",
    reportsProgress: true,
  },
];

function installLoadingDom(): void {
  document.body.innerHTML = `
    <div id="app">
      <div class="loading" id="app-loading">
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
  let ctl: Controller;
  let roots: AppRoots;
  let state: LoadingState;

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    installLoadingDom();
    // `ui.ts` binds `#app` when it loads, so it loads after the fixture.
    [ui, ctl, roots, state] = await Promise.all([
      import("../src/ui.js"),
      import("../src/loading-controller.js"),
      import("../src/mount/app-roots.js"),
      import("../src/state/loading.js"),
    ]);
  });

  afterEach(() => {
    roots.disposeAppRoots();
    sentry.captureException.mockClear();
    vi.useRealTimers();
  });

  /** Where the bar stands. */
  const progress = (): number => state.getLoadingState().progress;

  /** Start a load whose bar is crawling. */
  function startLoading(): void {
    ctl.initPhases(PHASES);
    ctl.advancePhase(0);
    // Prove the crawl really is running before anything stops it.
    const before = progress();
    vi.advanceTimersByTime(1_000);
    expect(progress()).not.toBe(before);
  }

  it("As a visitor whose name has no content, the loading bar stops ticking behind the error", () => {
    // Given
    startLoading();

    // When
    ui.showNoContentError("nothing");
    const frozen = progress();
    vi.advanceTimersByTime(STALL_MS * 5);

    // Then no crawl tick lands after the error
    expect(progress()).toBe(frozen);
    expect(document.querySelector(".error-page-title")?.textContent).toBe(
      "This app can't be reached",
    );
  });

  it("As a visitor whose load failed, the loading bar stops ticking behind the error", () => {
    // Given
    startLoading();

    // When
    ui.showErrorPage({ title: "Failed" });
    const frozen = progress();
    vi.advanceTimersByTime(STALL_MS * 5);

    // Then
    expect(progress()).toBe(frozen);
  });

  it("As a visitor whose load parked, the stall watch fires while the loading screen is up", () => {
    // Given
    const onStall = vi.fn();
    ctl.initPhases(PARKED_PHASES);
    ctl.onProgressStall(onStall);

    // When
    ctl.advancePhase(0);
    vi.advanceTimersByTime(STALL_MS + 100);

    // Then the fixture really does stall, so the tests below can fail
    expect(onStall).toHaveBeenCalledTimes(1);
  });

  it("As a visitor whose name has no content, the stall watch does not fire behind the error", () => {
    // Given
    const onStall = vi.fn();
    ctl.initPhases(PARKED_PHASES);
    ctl.onProgressStall(onStall);
    ctl.advancePhase(0);

    // When
    ui.showNoContentError("nothing");
    vi.advanceTimersByTime(STALL_MS * 5);

    // Then
    expect(onStall).not.toHaveBeenCalled();
  });

  it.each([
    [
      "an error page",
      (u: Ui) => {
        u.showErrorPage({ title: "Failed" });
      },
    ],
    [
      "a no-content page",
      (u: Ui) => {
        u.showNoContentError("nothing");
      },
    ],
  ])(
    "As a visitor, %s shown before the load starts removes the static screen",
    (_name, show) => {
      // Given the static screen, with no phases started
      const screen = document.getElementById("app-loading");

      // When
      show(ui);

      // Then
      expect(screen?.isConnected).toBe(false);
      expect(state.getLoadingState().phase).toBe("gone");
      expect(vi.getTimerCount()).toBe(0);
      expect(document.querySelector(".error-page-title")).not.toBeNull();
    },
  );

  it("As the shell, an error page disposes the page and loading roots before it replaces #app", () => {
    // Given
    const seen: string[] = [];
    const record = (name: string) => () => {
      // Disposal comes first, while the old content is still in place.
      expect(document.querySelector(".error-page")).toBeNull();
      seen.push(name);
    };
    // Registered loading first, so the order below is the dispose order.
    roots.registerAppRoot("loading", record("loading"));
    roots.registerAppRoot("page", record("page"));

    // When
    ui.showErrorPage({ title: "Failed" });

    // Then
    expect(seen).toEqual(["page", "loading"]);
    expect(document.querySelector(".error-page")).not.toBeNull();
  });

  it("As the shell, the no-content page disposes the page and loading roots before it replaces #app", () => {
    // Given
    const seen: string[] = [];
    const record = (name: string) => () => {
      expect(document.querySelector(".error-page")).toBeNull();
      seen.push(name);
    };
    // Registered loading first, so the order below is the dispose order.
    roots.registerAppRoot("loading", record("loading"));
    roots.registerAppRoot("page", record("page"));

    // When
    ui.showNoContentError("nothing");

    // Then
    expect(seen).toEqual(["page", "loading"]);
    expect(document.querySelector(".error-page")).not.toBeNull();
  });

  it("As the shell, disposing the loading root stops its timers and removes the overlay", () => {
    // Given
    startLoading();
    const loading = document.querySelector("#app > .loading");

    // When
    roots.disposeAppRoot("loading");
    const frozen = progress();
    vi.advanceTimersByTime(STALL_MS * 5);

    // Then
    expect(loading?.isConnected).toBe(false);
    expect(progress()).toBe(frozen);
  });

  it("As the shell, disposing the loading root stops the stall watch", () => {
    // Given
    const onStall = vi.fn();
    ctl.initPhases(PARKED_PHASES);
    ctl.onProgressStall(onStall);
    ctl.advancePhase(0);

    // When
    roots.disposeAppRoot("loading");
    vi.advanceTimersByTime(STALL_MS * 5);

    // Then
    expect(onStall).not.toHaveBeenCalled();
  });

  it.each([
    [
      "error page",
      (u: Ui) => {
        u.showErrorPage({ title: "Failed" });
      },
    ],
    [
      "no-content page",
      (u: Ui) => {
        u.showNoContentError("nothing");
      },
    ],
  ])(
    "As a visitor, the %s still renders when the page root fails to dispose",
    (_name, show) => {
      // Given
      const failure = new Error("page teardown failed");
      roots.registerAppRoot("page", () => {
        throw failure;
      });
      ctl.initPhases(PHASES);
      const loading = document.querySelector("#app > .loading");

      // When
      show(ui);

      // Then the loading root is still disposed and the error page is up
      expect(loading?.isConnected).toBe(false);
      expect(document.querySelector(".error-page-title")).not.toBeNull();
      expect(sentry.captureException).toHaveBeenCalledTimes(1);
      expect(sentry.captureException).toHaveBeenCalledWith(failure, {
        kind: "app_root_dispose_error",
        root: "page",
      });
    },
  );

  it("As the shell, starting the loading phases again keeps the overlay on screen", () => {
    // Given
    ctl.initPhases(PHASES);
    const loading = document.querySelector("#app > .loading");

    // When
    ctl.initPhases(PHASES);

    // Then
    expect(loading?.isConnected).toBe(true);

    // When
    roots.disposeAppRoot("loading");

    // Then
    expect(loading?.isConnected).toBe(false);
  });
});
