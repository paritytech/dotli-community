// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The shell islands loader (mount/load-islands.ts) against a stand-in chunk
// whose arrival each test controls. The real chunk is covered by
// tests/components/shell/islands.test.tsx.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BlockingModalCoordinator } from "@dotli/ui/blocking-modal-queue";

const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock("@dotli/metrics/sentry", () => sentry);

const ISLANDS_CHUNK = "@dotli/ui/components/shell/islands";

interface Chunk {
  /** The pending import of the chunk finishes loading. */
  arrive: () => Promise<void>;
  /** The pending import of the chunk fails. */
  fail: (err: unknown) => Promise<void>;
  /** How many times the chunk was imported. */
  imports: () => number;
  mountIslands: ReturnType<typeof vi.fn>;
  /** Clicks the island's (swapped-in) theme button received. */
  islandClicks: () => number;
  /** Clicks the island's (swapped-in) permissions button received. */
  permissionsClicks: () => number;
}

/** Lets pending I/O and promise callbacks run. */
function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

interface StubOptions {
  /** mountIslands throws this before swapping anything. */
  mountError?: Error;
  /** The banner island fails and its static node stays, as mountIsland does. */
  bannerIslandFails?: boolean;
  /** Islands mountIslands reports as failed (besides the banner). */
  failedIslands?: string[];
}

/**
 * Stands in for the islands chunk: each import waits until the test lets it
 * arrive or fail; once it arrives, mountIslands swaps a fresh theme button
 * and a fresh permissions button, which count their clicks, and a fresh
 * offline banner in for the static ones.
 */
function stubChunk(options: StubOptions = {}): Chunk {
  const requests: PromiseWithResolvers<void>[] = [];
  let settled = 0;
  /** The oldest import not yet settled, once the loader has made it. */
  const nextRequest = async (): Promise<PromiseWithResolvers<void>> => {
    while (requests.length <= settled) {
      await tick();
    }
    settled += 1;
    return requests[settled - 1];
  };
  let clicks = 0;
  let permissionsClicks = 0;
  const mountIslands = vi.fn(() => {
    if (options.mountError !== undefined) {
      throw options.mountError;
    }
    const fresh = document.createElement("button");
    fresh.id = "theme-toggle";
    fresh.addEventListener("click", () => {
      clicks += 1;
    });
    document.getElementById("theme-toggle")?.replaceWith(fresh);
    const permissions = document.createElement("button");
    permissions.id = "permissions-button";
    permissions.addEventListener("click", () => {
      permissionsClicks += 1;
    });
    document.getElementById("permissions-button")?.replaceWith(permissions);
    const failed = [...(options.failedIslands ?? [])];
    if (options.bannerIslandFails === true) {
      failed.push("offline-banner");
    } else {
      const banner = document.createElement("div");
      banner.id = "offline-banner";
      banner.style.display = "none";
      document.getElementById("offline-banner")?.replaceWith(banner);
    }
    return failed;
  });
  vi.doMock(ISLANDS_CHUNK, async () => {
    const request = Promise.withResolvers<void>();
    requests.push(request);
    await request.promise;
    return { mountIslands };
  });
  return {
    arrive: async () => {
      (await nextRequest()).resolve();
      await tick();
    },
    fail: async (err) => {
      (await nextRequest()).reject(err);
      await tick();
    },
    imports: () => requests.length,
    mountIslands,
    islandClicks: () => clicks,
    permissionsClicks: () => permissionsClicks,
  };
}

async function loadLoader(): Promise<
  typeof import("@dotli/ui/mount/load-islands")
> {
  return import("@dotli/ui/mount/load-islands");
}

/**
 * Wires the loader's instance of the auth controller (modules are reset per
 * test) to a real blocking-modal queue, as initTopBar does at boot, and
 * counts the login requests and cancels it dispatches.
 */
async function initAuth(): Promise<{
  coordinator: BlockingModalCoordinator;
  modalOpen: () => boolean;
  loginRequests: () => number;
  cancels: () => number;
}> {
  const [{ initAuthController }, { createBlockingModalCoordinator }, modal] =
    await Promise.all([
      import("@dotli/ui/auth-controller"),
      import("@dotli/ui/blocking-modal-queue"),
      import("@dotli/ui/state/auth-modal"),
    ]);
  const coordinator = createBlockingModalCoordinator();
  initAuthController(coordinator);
  let loginRequests = 0;
  let cancels = 0;
  window.addEventListener("dotli:truapi-login-request", () => {
    loginRequests += 1;
  });
  window.addEventListener("dotli:truapi-cancel-login", () => {
    cancels += 1;
  });
  return {
    coordinator,
    modalOpen: () => modal.getAuthModalState().open,
    loginRequests: () => loginRequests,
    cancels: () => cancels,
  };
}

function requestLogin(): void {
  window.dispatchEvent(
    new CustomEvent("dotli:request-login", {
      detail: { reason: "Sign the transfer", label: "localhost:3000" },
    }),
  );
}

function corePairing(): void {
  window.dispatchEvent(
    new CustomEvent("dotli:truapi-auth-state", {
      detail: {
        tag: "Pairing",
        deeplink: "polkadotapp://pair?handshake=test",
        label: "localhost:3000",
      },
    }),
  );
}

/** Whether a blocking prompt enqueued now runs (rather than waiting). */
async function blockingPromptRuns(
  coordinator: BlockingModalCoordinator,
): Promise<boolean> {
  const scope = coordinator.createScope();
  let ran = false;
  // Disposing a still-queued prompt rejects it.
  scope
    .enqueue(() => {
      ran = true;
    })
    .catch(() => undefined);
  await tick();
  scope.dispose();
  return ran;
}

function byId(id: string): HTMLElement {
  return document.getElementById(id) as HTMLElement;
}

/** Clicks `target` the way a user does; returns the dispatched event. */
function click(target: Element): MouseEvent {
  const event = new MouseEvent("click", { bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

let windowListeners: ReturnType<typeof vi.spyOn<Window, "addEventListener">>;

beforeEach(() => {
  vi.resetModules();
  // Recorded so afterEach can remove what the offline fallback adds.
  windowListeners = vi.spyOn(window, "addEventListener");
  document.body.innerHTML = [
    '<button id="theme-toggle" class="topbar-btn"><svg><path d="M0 0"/></svg></button>',
    '<div id="theme-popover" class="more-popover theme-popover"></div>',
    '<button id="other" type="button">Other</button>',
    '<button class="more-row" data-target="theme-toggle">Theme</button>',
    '<button id="permissions-button" class="topbar-btn"><svg><rect/></svg></button>',
    '<button class="more-row" data-target="permissions-button">Permissions</button>',
    '<div id="offline-banner" role="status" aria-live="polite" style="position:absolute;display:none">You are offline</div>',
  ].join("");
});

afterEach(() => {
  for (const [type, listener] of windowListeners.mock.calls) {
    window.removeEventListener(type, listener);
  }
  vi.restoreAllMocks();
  vi.doUnmock(ISLANDS_CHUNK);
  sentry.captureException.mockReset();
  document.body.replaceChildren();
});

describe("ensureIslands", () => {
  it("As a dotli user, clicks on the theme button before the islands mount open it once, after they do", async () => {
    // Given
    const chunk = stubChunk();
    const { ensureIslands } = await loadLoader();
    const loading = ensureIslands();

    // When: clicked twice, once on the icon inside the button.
    const first = click(byId("theme-toggle").querySelector("path") as Element);
    const second = click(byId("theme-toggle"));
    chunk.arrive();
    await loading;

    // Then
    expect(first.defaultPrevented).toBe(true);
    expect(second.defaultPrevented).toBe(true);
    expect(chunk.mountIslands).toHaveBeenCalledTimes(1);
    expect(chunk.islandClicks()).toBe(1);
  });

  it("As a dotli user, clicks on the permissions button before the islands mount open it once, after they do", async () => {
    // Given
    const chunk = stubChunk();
    const { ensureIslands } = await loadLoader();
    const loading = ensureIslands();

    // When: clicked twice, once on the icon inside the button.
    const first = click(
      byId("permissions-button").querySelector("rect") as Element,
    );
    const second = click(byId("permissions-button"));
    chunk.arrive();
    await loading;

    // Then
    expect(first.defaultPrevented).toBe(true);
    expect(second.defaultPrevented).toBe(true);
    expect(chunk.permissionsClicks()).toBe(1);
    expect(chunk.islandClicks()).toBe(0);

    // When: after the mount, clicks reach the island directly.
    const after = click(byId("permissions-button"));

    // Then
    expect(after.defaultPrevented).toBe(false);
    expect(chunk.permissionsClicks()).toBe(2);
  });

  it("As a mobile user, tapping the More menu's Permissions row before the islands mount opens the permissions popover once they do", async () => {
    // Given: topbar.ts's More menu forwards a row tap as a click on its
    // target, looked up by id at click time, after stopping the row's own
    // click.
    const chunk = stubChunk();
    const { ensureIslands } = await loadLoader();
    const row = document.querySelector(
      '.more-row[data-target="permissions-button"]',
    ) as HTMLElement;
    row.addEventListener("click", (e) => {
      e.stopPropagation();
      document.getElementById(row.dataset.target ?? "")?.click();
    });
    const loading = ensureIslands();

    // When
    click(row);
    chunk.arrive();
    await loading;

    // Then
    expect(chunk.permissionsClicks()).toBe(1);

    // When: the same row after the mount.
    click(row);

    // Then
    expect(chunk.permissionsClicks()).toBe(2);
  });

  it("As a dotli user, clicks elsewhere before the mount, and every click after it, pass through untouched", async () => {
    // Given
    const chunk = stubChunk();
    const { ensureIslands } = await loadLoader();
    const loading = ensureIslands();

    // When
    const elsewhere = click(byId("other"));
    chunk.arrive();
    await loading;
    const after = click(byId("theme-toggle"));

    // Then
    expect(elsewhere.defaultPrevented).toBe(false);
    expect(after.defaultPrevented).toBe(false);
    expect(chunk.islandClicks()).toBe(1);
  });

  it("As the host, calling it again reuses the one load and mounts the islands once", async () => {
    // Given
    const chunk = stubChunk();
    const { ensureIslands } = await loadLoader();

    // When
    const first = ensureIslands();
    const second = ensureIslands();
    chunk.arrive();
    await Promise.all([first, second]);
    await ensureIslands();

    // Then
    expect(second).toBe(first);
    expect(chunk.mountIslands).toHaveBeenCalledTimes(1);
  });

  it("As a dotli user, when the islands chunk cannot load, it is not retried: the static shell stays, the failure is reported once, nothing is replayed and clicks are no longer held back", async () => {
    // Given
    const chunk = stubChunk();
    const { ensureIslands } = await loadLoader();
    const staticButton = byId("theme-toggle");
    const staticClicks = vi.fn();
    staticButton.addEventListener("click", staticClicks);
    const loading = ensureIslands();
    click(staticButton);
    const err = new Error("chunk failed");

    // When
    await chunk.fail(err);

    // Then
    await expect(loading).resolves.toBeUndefined();
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    // Vitest wraps a mock factory's error; the chunk's is its cause.
    expect(sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ cause: err }),
      { kind: "islands_load_error" },
    );
    expect(byId("theme-toggle")).toBe(staticButton);
    // The held-back click still reached the button once; no replay follows.
    expect(staticClicks).toHaveBeenCalledTimes(1);

    // When
    const after = click(staticButton);
    await ensureIslands();
    await tick();

    // Then: no second attempt.
    expect(after.defaultPrevented).toBe(false);
    expect(staticClicks).toHaveBeenCalledTimes(2);
    expect(chunk.imports()).toBe(1);
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
  });

  it("As a mobile user, tapping the More menu's Theme row before the islands mount opens the theme menu once they do", async () => {
    // Given: topbar.ts's More menu forwards a row tap as a click on its
    // target, after stopping the row's own click.
    const chunk = stubChunk();
    const { ensureIslands } = await loadLoader();
    const row = document.querySelector(".more-row") as HTMLElement;
    row.addEventListener("click", (e) => {
      e.stopPropagation();
      document.getElementById(row.dataset.target ?? "")?.click();
    });
    const loading = ensureIslands();

    // When
    click(row);
    chunk.arrive();
    await loading;

    // Then
    expect(chunk.islandClicks()).toBe(1);
  });

  it("As a dotli user, when mounting the islands throws, it is reported as a mount failure, nothing is replayed and clicks are no longer held back", async () => {
    // Given
    const err = new Error("mount failed");
    const chunk = stubChunk({ mountError: err });
    const { ensureIslands } = await loadLoader();
    const staticButton = byId("theme-toggle");
    const staticClicks = vi.fn();
    staticButton.addEventListener("click", staticClicks);
    const loading = ensureIslands();
    click(staticButton);

    // When
    chunk.arrive();

    // Then
    await expect(loading).resolves.toBeUndefined();
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    expect(sentry.captureException).toHaveBeenCalledWith(err, {
      kind: "islands_mount_error",
    });
    expect(staticClicks).toHaveBeenCalledTimes(1);

    // When
    const after = click(staticButton);

    // Then
    expect(after.defaultPrevented).toBe(false);
    expect(staticClicks).toHaveBeenCalledTimes(2);
  });

  it("As a user who is offline when the page boots, so the islands chunk cannot load, I still see the static offline banner, and it follows the connection and the topbar", async () => {
    // Given
    let online = false;
    vi.spyOn(navigator, "onLine", "get").mockImplementation(() => online);
    const chunk = stubChunk();
    const { ensureIslands } = await loadLoader();
    // The loader's instance of the store (modules are reset per test).
    const { setTopbarVisible } = await import("@dotli/ui/state/topbar");
    const staticBanner = byId("offline-banner");
    const loading = ensureIslands();

    // When
    await chunk.fail(new Error("offline"));
    await loading;

    // Then
    expect(byId("offline-banner")).toBe(staticBanner);
    expect(staticBanner.style.display).toBe("block");
    expect(staticBanner.style.position).toBe("absolute");

    // When
    online = true;
    window.dispatchEvent(new Event("online"));

    // Then
    expect(staticBanner.style.display).toBe("none");

    // When
    online = false;
    window.dispatchEvent(new Event("offline"));

    // Then
    expect(staticBanner.style.display).toBe("block");

    // When
    setTopbarVisible(false);

    // Then
    expect(staticBanner.style.display).toBe("none");

    // When
    setTopbarVisible(true);

    // Then
    expect(staticBanner.style.display).toBe("block");
  });

  it("As a dotli user online whose islands chunk cannot load, the static offline banner stays hidden until the connection drops", async () => {
    // Given
    let online = true;
    vi.spyOn(navigator, "onLine", "get").mockImplementation(() => online);
    const chunk = stubChunk();
    const { ensureIslands } = await loadLoader();
    const loading = ensureIslands();

    // When
    await chunk.fail(new Error("chunk failed"));
    await loading;

    // Then
    expect(byId("offline-banner").style.display).toBe("none");

    // When
    online = false;
    window.dispatchEvent(new Event("offline"));

    // Then
    expect(byId("offline-banner").style.display).toBe("block");
  });

  it("As a dotli user, when the islands mount, the offline banner is the island's alone: the loader does not touch it", async () => {
    // Given
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const chunk = stubChunk();
    const { ensureIslands } = await loadLoader();
    const staticBanner = byId("offline-banner");
    const loading = ensureIslands();

    // When
    await chunk.arrive();
    await loading;
    window.dispatchEvent(new Event("offline"));

    // Then: the stand-in banner island is hidden, and only the loader could
    // show either banner.
    expect(byId("offline-banner")).not.toBe(staticBanner);
    expect(byId("offline-banner").style.display).toBe("none");
    expect(staticBanner.style.display).toBe("none");
  });

  it("As a user offline, when the banner island alone fails to mount, I still see the static offline banner", async () => {
    // Given
    let online = false;
    vi.spyOn(navigator, "onLine", "get").mockImplementation(() => online);
    const chunk = stubChunk({ bannerIslandFails: true });
    const { ensureIslands } = await loadLoader();
    const staticBanner = byId("offline-banner");
    const loading = ensureIslands();

    // When
    await chunk.arrive();
    await loading;

    // Then: the other islands mounted; the static banner follows the
    // connection.
    expect(chunk.islandClicks()).toBe(0);
    expect(byId("theme-toggle").isConnected).toBe(true);
    expect(byId("offline-banner")).toBe(staticBanner);
    expect(staticBanner.style.display).toBe("block");

    // When
    online = true;
    window.dispatchEvent(new Event("online"));

    // Then
    expect(staticBanner.style.display).toBe("none");
  });

  it("As a user offline, when mounting the islands throws, I still see the static offline banner", async () => {
    // Given
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const chunk = stubChunk({ mountError: new Error("mount failed") });
    const { ensureIslands } = await loadLoader();
    const staticBanner = byId("offline-banner");
    const loading = ensureIslands();

    // When
    await chunk.arrive();
    await loading;

    // Then
    expect(byId("offline-banner")).toBe(staticBanner);
    expect(staticBanner.style.display).toBe("block");
  });
});

describe("ensureIslands and the auth modal", () => {
  it("As a product, when the islands chunk cannot load while my login waits on the invisible modal, the login is cancelled and my next blocking prompt proceeds", async () => {
    // Given: a login holds the blocking-modal lease before the chunk arrives,
    // and a permission prompt queues behind it.
    const chunk = stubChunk();
    const { ensureIslands } = await loadLoader();
    const auth = await initAuth();
    const loading = ensureIslands();
    requestLogin();
    expect(auth.modalOpen()).toBe(true);
    const prompt = auth.coordinator.createScope();
    let promptRan = false;
    const queued = prompt.enqueue(() => {
      promptRan = true;
    });

    // When
    await chunk.fail(new Error("chunk failed"));
    await loading;
    await queued;

    // Then
    expect(auth.modalOpen()).toBe(false);
    expect(auth.cancels()).toBe(1);
    expect(promptRan).toBe(true);
    prompt.dispose();
  });

  it("As a product, after the islands chunk failed to load, a new login is cancelled instead of taking the blocking-modal lease", async () => {
    // Given
    const chunk = stubChunk();
    const { ensureIslands } = await loadLoader();
    const auth = await initAuth();
    const loading = ensureIslands();
    await chunk.fail(new Error("chunk failed"));
    await loading;

    // When: a direct login request.
    requestLogin();

    // Then
    expect(auth.modalOpen()).toBe(false);
    expect(auth.cancels()).toBe(1);
    expect(auth.loginRequests()).toBe(0);
    expect(await blockingPromptRuns(auth.coordinator)).toBe(true);

    // When: the core starts pairing for a product.
    corePairing();

    // Then
    expect(auth.modalOpen()).toBe(false);
    expect(auth.cancels()).toBe(2);
    expect(await blockingPromptRuns(auth.coordinator)).toBe(true);
  });

  it("As a product, when mounting the islands throws, a pending login is cancelled and later logins do not take the lease", async () => {
    // Given
    const chunk = stubChunk({ mountError: new Error("mount failed") });
    const { ensureIslands } = await loadLoader();
    const auth = await initAuth();
    const loading = ensureIslands();
    requestLogin();

    // When
    await chunk.arrive();
    await loading;

    // Then
    expect(auth.modalOpen()).toBe(false);
    expect(auth.cancels()).toBe(1);
    expect(await blockingPromptRuns(auth.coordinator)).toBe(true);

    // When
    corePairing();

    // Then
    expect(auth.modalOpen()).toBe(false);
    expect(auth.cancels()).toBe(2);
  });

  it("As a product, when only the auth-modal island fails to mount, a pending login is cancelled, my next prompt proceeds and later logins are cancelled", async () => {
    // Given
    const chunk = stubChunk({ failedIslands: ["auth-modal"] });
    const { ensureIslands } = await loadLoader();
    const auth = await initAuth();
    const loading = ensureIslands();
    requestLogin();
    expect(auth.modalOpen()).toBe(true);

    // When
    await chunk.arrive();
    await loading;

    // Then: the other islands mounted.
    expect(byId("offline-banner").style.display).toBe("none");
    expect(auth.modalOpen()).toBe(false);
    expect(auth.cancels()).toBe(1);
    expect(await blockingPromptRuns(auth.coordinator)).toBe(true);

    // When
    requestLogin();
    corePairing();

    // Then
    expect(auth.modalOpen()).toBe(false);
    expect(auth.cancels()).toBe(3);
    expect(auth.loginRequests()).toBe(1);
    expect(await blockingPromptRuns(auth.coordinator)).toBe(true);
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it("As a product, when the auth-modal island mounts, even if another island fails, my login keeps its modal and lease", async () => {
    // Given
    const chunk = stubChunk({ failedIslands: ["theme"] });
    const { ensureIslands } = await loadLoader();
    const auth = await initAuth();
    const loading = ensureIslands();
    requestLogin();

    // When
    await chunk.arrive();
    await loading;

    // Then
    expect(auth.modalOpen()).toBe(true);
    expect(auth.cancels()).toBe(0);
    expect(await blockingPromptRuns(auth.coordinator)).toBe(false);

    // When: a later Pairing reuses the lease.
    corePairing();

    // Then
    expect(auth.modalOpen()).toBe(true);
    expect(auth.cancels()).toBe(0);
    expect(auth.loginRequests()).toBe(1);
  });
});
