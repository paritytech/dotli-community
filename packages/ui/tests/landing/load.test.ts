// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The landing loader (landing/load.ts): it keeps the loading screen until the
// landing chunk arrives, then swaps the page in as the "page" app root, and
// shows the error page if the chunk cannot load.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock("@dotli/metrics/sentry", () => sentry);
vi.mock("@dotli/ui/recent-labels", () => ({
  loadRecentLabels: () => Promise.resolve(["alpha"]),
  forgetRecentLabel: () => Promise.resolve(),
}));

const CHUNK = "@dotli/ui/components/landing/mount";

type Loader = typeof import("@dotli/ui/landing/load");
type AppRoots = typeof import("@dotli/ui/mount/app-roots");
type Ui = typeof import("@dotli/ui/ui");
type LoadingState = typeof import("@dotli/ui/state/loading");

let load: Loader;
let roots: AppRoots;
let ui: Ui;
let loading: LoadingState;

/**
 * Fresh modules, so each test gets its own memoized loader. The loading
 * controller loads too, over the static screen, as the host's startup
 * bundle loads it on every path: that is what makes the screen a root.
 */
async function importFresh(): Promise<void> {
  [load, roots, ui, loading] = await Promise.all([
    import("@dotli/ui/landing/load"),
    import("@dotli/ui/mount/app-roots"),
    import("@dotli/ui/ui"),
    import("@dotli/ui/state/loading"),
    import("@dotli/ui/loading-controller"),
  ]);
}

/** Hold the landing chunk back until the returned function is called. */
function gateChunk(): () => void {
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.doMock(CHUNK, async () => {
    await gate;
    return vi.importActual(CHUNK);
  });
  return release;
}

function byId(id: string): HTMLElement | null {
  return document.getElementById(id);
}

function app(): HTMLElement {
  return byId("app") as HTMLElement;
}

/** Let queued microtasks run, Solid's batched updates among them. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

beforeEach(async () => {
  vi.resetModules();
  sentry.captureException.mockReset();
  // Shaped like apps/host/index.html: the topbar, then `#app` holding the
  // static loading screen.
  document.body.innerHTML = `<div id="topbar"><button id="auth-button"></button><button id="theme-toggle"></button><div id="theme-popover"></div></div><div id="app"><div class="loading" id="app-loading"></div></div>`;
});

afterEach(() => {
  roots.disposeAppRoots();
  vi.doUnmock(CHUNK);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("landing loader", () => {
  it("As a visitor, the loading screen stays up until the landing page is ready, then the page replaces it", async () => {
    // Given
    const release = gateChunk();
    await importFresh();

    // When
    const shown = load.showLanding();
    await settle();

    // Then: nothing changed while the chunk downloads.
    expect(loading.getLoadingState().phase).toBe("active");
    expect(byId("app-loading")).not.toBeNull();
    expect(byId("topbar")?.style.display).toBe("");
    expect(byId("app-view")).toBeNull();

    // When
    release();
    await shown;
    await settle();

    // Then the static screen went
    expect(byId("app-loading")).toBeNull();
    expect(loading.getLoadingState().phase).toBe("gone");
    expect(byId("topbar")?.style.display).toBe("none");
    expect(app().style.marginTop).toBe("0px");
    expect(app().style.minHeight).toBe("100dvh");
    expect([...app().children].map((el) => el.id)).toEqual(["app-view"]);
    const view = byId("app-view") as HTMLElement;
    expect(view.firstElementChild?.className).toBe("landing");
    expect(
      [...(byId("landing-auth") as HTMLElement).children].map((el) => el.id),
    ).toEqual(["auth-button", "theme-toggle", "theme-popover"]);
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it("As a visitor, the landing page mounts once however often it is asked for", async () => {
    // Given
    await importFresh();

    // When
    const first = load.showLanding();
    const second = load.showLanding();
    await first;
    await load.showLanding();

    // Then
    expect(second).toBe(first);
    expect(document.querySelectorAll(".landing")).toHaveLength(1);
  });

  it("As a visitor, the landing page is the page app root, so whatever replaces the page disposes it", async () => {
    // Given
    await importFresh();
    const remove = vi.spyOn(document, "removeEventListener");
    await load.showLanding();
    await settle();
    expect(document.querySelectorAll(".landing-recent-item")).toHaveLength(1);

    // When: what activateHost calls for the product frame.
    roots.disposeAppRoot("page");

    // Then
    expect(document.querySelector(".landing")).toBeNull();
    expect(remove).toHaveBeenCalledWith("pointerdown", expect.any(Function));
  });

  it("As a visitor, an error page disposes the landing page, typing placeholder and all", async () => {
    // Given
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await importFresh();
      await load.showLanding();
      await settle();
      expect(vi.getTimerCount()).toBe(1);

      // When
      ui.showErrorPage({ title: "Failed" });

      // Then
      expect(document.querySelector(".landing")).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
      expect(document.querySelector(".error-page-title")?.textContent).toBe(
        "Failed",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("As a visitor, when the landing page cannot load, I see an error page with a reload button, and it is reported once", async () => {
    // Given
    vi.doMock(CHUNK, () => {
      throw new Error("chunk failed");
    });
    await importFresh();
    const reload = vi.fn();
    vi.stubGlobal("location", { reload });

    // When
    await expect(load.showLanding()).resolves.toBeUndefined();
    await load.showLanding();

    // Then
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    expect(sentry.captureException).toHaveBeenCalledWith(expect.any(Error), {
      kind: "landing_load_error",
    });
    expect(byId("app-loading")).toBeNull();
    expect(document.querySelector(".error-page-title")?.textContent).toBe(
      "Something went wrong on our side",
    );
    expect(document.querySelector(".error-page-detail")?.textContent).toBe(
      "This page didn't load properly. Reloading usually fixes it.",
    );
    const button = byId("error-retry-btn") as HTMLButtonElement;
    expect(button.textContent).toBe("Reload");

    // When
    button.click();

    // Then
    expect(reload).toHaveBeenCalledTimes(1);
  });
  it("As a visitor, when the landing page fails to render, I see an error page with a reload button, and it is reported once", async () => {
    // Given
    const failure = new Error("landing render failed");
    vi.doMock("@dotli/ui/components/landing/Landing", () => ({
      Landing: () => {
        throw failure;
      },
    }));
    await importFresh();
    const reload = vi.fn();
    vi.stubGlobal("location", { reload });

    // When
    await load.showLanding();
    await settle();

    // Then
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    expect(sentry.captureException).toHaveBeenCalledWith(failure, {
      root: "page",
    });
    expect(document.querySelector(".landing")).toBeNull();
    expect(document.querySelector(".error-page-title")?.textContent).toBe(
      "Something went wrong on our side",
    );
    expect(document.querySelectorAll(".error-page")).toHaveLength(1);

    // When
    (byId("error-retry-btn") as HTMLButtonElement).click();

    // Then
    expect(reload).toHaveBeenCalledTimes(1);
    vi.doUnmock("@dotli/ui/components/landing/Landing");
  });
  it("As a visitor, a landing page whose error fallback runs twice shows the error page once", async () => {
    // Given a landing chunk whose root reports its render error twice
    vi.doMock(CHUNK, () => ({
      mountLanding: (_view: HTMLElement, onError: (err: unknown) => void) => {
        onError(new Error("first"));
        onError(new Error("second"));
        return () => {};
      },
    }));
    await importFresh();
    let errorPagesWritten = 0;
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node instanceof HTMLElement && node.matches(".error-page")) {
            errorPagesWritten++;
          }
        }
      }
    });
    observer.observe(app(), { childList: true });

    // When
    await load.showLanding();
    await settle();
    observer.disconnect();

    // Then
    expect(errorPagesWritten).toBe(1);
    expect(document.querySelector(".error-page-title")?.textContent).toBe(
      "Something went wrong on our side",
    );
  });
});
