// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The shell islands loader (mount/load-islands.ts) against a stand-in chunk
// whose arrival each test controls. The real chunk is covered by
// tests/components/shell/islands.test.tsx.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BlockingModalCoordinator } from "@dotli/ui/blocking-modal-queue";
import {
  mountMoreMenu,
  tapMoreRow,
} from "../components/shell/more-menu-harness";

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
  /** The `detail` of each click the island's theme button received. */
  islandClickDetails: () => number[];
  /** Clicks the island's (swapped-in) permissions button received. */
  permissionsClicks: () => number;
  /** Clicks the island's (swapped-in) network button received. */
  chainsClicks: () => number;
  /** Clicks the island's (swapped-in) settings button received. */
  settingsClicks: () => number;
  /** Clicks the island's (swapped-in) More button received. */
  moreClicks: () => number;
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
 * arrive or fail; once it arrives, mountIslands swaps a fresh theme button,
 * permissions button, network button, settings button and More button, which
 * count their clicks, and a fresh offline banner in for the static ones.
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
  const clickDetails: number[] = [];
  let permissionsClicks = 0;
  let chainsClicks = 0;
  let settingsClicks = 0;
  let moreClicks = 0;
  const mountIslands = vi.fn(() => {
    if (options.mountError !== undefined) {
      throw options.mountError;
    }
    const fresh = document.createElement("button");
    fresh.id = "theme-toggle";
    fresh.addEventListener("click", (ev) => {
      clicks += 1;
      clickDetails.push(ev.detail);
    });
    document.getElementById("theme-toggle")?.replaceWith(fresh);
    const permissions = document.createElement("button");
    permissions.id = "permissions-button";
    permissions.addEventListener("click", () => {
      permissionsClicks += 1;
    });
    document.getElementById("permissions-button")?.replaceWith(permissions);
    const chains = document.createElement("button");
    chains.id = "chains-button";
    chains.addEventListener("click", () => {
      chainsClicks += 1;
    });
    document.getElementById("chains-button")?.replaceWith(chains);
    const settings = document.createElement("button");
    settings.id = "mode-button";
    settings.addEventListener("click", () => {
      settingsClicks += 1;
    });
    document.getElementById("mode-button")?.replaceWith(settings);
    const more = document.createElement("button");
    more.id = "more-button";
    more.addEventListener("click", () => {
      moreClicks += 1;
    });
    document.getElementById("more-button")?.replaceWith(more);
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
    islandClickDetails: () => clickDetails,
    permissionsClicks: () => permissionsClicks,
    chainsClicks: () => chainsClicks,
    settingsClicks: () => settingsClicks,
    moreClicks: () => moreClicks,
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
  const [
    { initAuthController },
    { createBlockingModalCoordinator },
    modal,
    { setAuthState },
  ] = await Promise.all([
    import("@dotli/ui/auth-controller"),
    import("@dotli/ui/blocking-modal-queue"),
    import("@dotli/ui/state/auth-modal"),
    import("@dotli/ui/state/auth"),
  ]);
  recordAuthState = setAuthState;
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

/** The auth store of the controller initAuth wired. */
let recordAuthState: (typeof import("@dotli/ui/state/auth"))["setAuthState"];

function corePairing(): void {
  recordAuthState({
    tag: "Pairing",
    deeplink: "polkadotapp://pair?handshake=test",
    label: "localhost:3000",
  });
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

/**
 * Clicks `target` the way a user does (`detail` 1 for a mouse, 0 for a
 * key); returns the dispatched event.
 */
function click(target: Element, detail = 0): MouseEvent {
  const event = new MouseEvent("click", {
    bubbles: true,
    cancelable: true,
    detail,
  });
  target.dispatchEvent(event);
  return event;
}

let windowListeners: ReturnType<typeof vi.spyOn<Window, "addEventListener">>;
let unmountMore: (() => void) | null = null;

beforeEach(() => {
  vi.resetModules();
  // Recorded so afterEach can remove what the offline fallback adds.
  windowListeners = vi.spyOn(window, "addEventListener");
  document.body.innerHTML = [
    '<button id="theme-toggle" class="topbar-btn"><svg><path d="M0 0"/></svg></button>',
    '<div id="theme-popover" class="more-popover theme-popover"></div>',
    '<button id="other" type="button">Other</button>',
    '<button id="permissions-button" class="topbar-btn"><svg><rect/></svg></button>',
    '<button id="chains-button" class="topbar-btn topbar-chains-btn visible"><svg><circle/></svg></button>',
    '<button id="mode-button" class="topbar-btn"><svg><circle/></svg></button>',
    '<button id="more-button" class="topbar-btn topbar-more-btn"><span class="hamburger"></span></button>',
    '<div class="more-popover" id="more-popover"></div>',
    '<div id="offline-banner" role="status" aria-live="polite" style="position:absolute;display:none">You are offline</div>',
  ].join("");
});

afterEach(() => {
  unmountMore?.();
  unmountMore = null;
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

  it("As a dotli user, clicks on the network button before the islands mount open it once, after they do", async () => {
    // Given
    const chunk = stubChunk();
    const { ensureIslands } = await loadLoader();
    const loading = ensureIslands();

    // When: clicked twice, once on the globe inside the button.
    const first = click(
      byId("chains-button").querySelector("circle") as Element,
    );
    const second = click(byId("chains-button"));
    chunk.arrive();
    await loading;

    // Then
    expect(first.defaultPrevented).toBe(true);
    expect(second.defaultPrevented).toBe(true);
    expect(chunk.chainsClicks()).toBe(1);
    expect(chunk.permissionsClicks()).toBe(0);
    expect(chunk.islandClicks()).toBe(0);

    // When: after the mount, clicks reach the island directly.
    const after = click(byId("chains-button"));

    // Then
    expect(after.defaultPrevented).toBe(false);
    expect(chunk.chainsClicks()).toBe(2);
  });

  it("As a dotli user, clicks on the settings button before the islands mount open it once, after they do", async () => {
    // Given
    const chunk = stubChunk();
    const { ensureIslands } = await loadLoader();
    const loading = ensureIslands();

    // When: clicked twice, once on the icon inside the button.
    const first = click(byId("mode-button").querySelector("circle") as Element);
    const second = click(byId("mode-button"));
    chunk.arrive();
    await loading;

    // Then
    expect(first.defaultPrevented).toBe(true);
    expect(second.defaultPrevented).toBe(true);
    expect(chunk.settingsClicks()).toBe(1);
    expect(chunk.chainsClicks()).toBe(0);
    expect(chunk.permissionsClicks()).toBe(0);
    expect(chunk.islandClicks()).toBe(0);

    // When: after the mount, clicks reach the island directly.
    const after = click(byId("mode-button"));

    // Then
    expect(after.defaultPrevented).toBe(false);
    expect(chunk.settingsClicks()).toBe(2);
  });

  it("As a dotli user, clicks on the More button before the islands mount open it once, after they do", async () => {
    // Given
    const chunk = stubChunk();
    const { ensureIslands } = await loadLoader();
    const loading = ensureIslands();

    // When: clicked twice, once on the icon inside the button.
    const first = click(
      byId("more-button").querySelector(".hamburger") as Element,
    );
    const second = click(byId("more-button"));
    chunk.arrive();
    await loading;

    // Then
    expect(first.defaultPrevented).toBe(true);
    expect(second.defaultPrevented).toBe(true);
    expect(chunk.moreClicks()).toBe(1);
    expect(chunk.settingsClicks()).toBe(0);
    expect(chunk.islandClicks()).toBe(0);

    // When: after the mount, clicks reach the island directly.
    const after = click(byId("more-button"));

    // Then
    expect(after.defaultPrevented).toBe(false);
    expect(chunk.moreClicks()).toBe(2);
  });

  it("As a mobile user, the More menu's Settings row tapped before the settings island mounts opens it once it does", async () => {
    // Given: the real More menu, mounted ahead of the settings island. Its
    // row forwards the tap to whichever #mode-button is there at click time.
    const chunk = stubChunk();
    const { ensureIslands } = await loadLoader();
    unmountMore = mountMoreMenu();
    const loading = ensureIslands();

    // When
    await tapMoreRow("mode-button");
    chunk.arrive();
    await loading;

    // Then
    expect(chunk.settingsClicks()).toBe(1);

    // When: the same row after the mount.
    await tapMoreRow("mode-button");

    // Then
    expect(chunk.settingsClicks()).toBe(2);
  });

  it("As a mobile user, the More menu's Permissions row tapped before the permissions island mounts opens it once it does", async () => {
    // Given: the real More menu, mounted ahead of the permissions island.
    const chunk = stubChunk();
    const { ensureIslands } = await loadLoader();
    unmountMore = mountMoreMenu();
    const loading = ensureIslands();

    // When
    await tapMoreRow("permissions-button");
    chunk.arrive();
    await loading;

    // Then
    expect(chunk.permissionsClicks()).toBe(1);

    // When: the same row after the mount.
    await tapMoreRow("permissions-button");

    // Then
    expect(chunk.permissionsClicks()).toBe(2);
  });

  it.each([
    ["theme, then settings", ["theme-toggle", "mode-button"], "mode-button"],
    [
      "theme, settings, then theme again",
      ["theme-toggle", "mode-button", "theme-toggle"],
      "theme-toggle",
    ],
    [
      "More, then permissions",
      ["more-button", "permissions-button"],
      "permissions-button",
    ],
  ])(
    "As a dotli user who clicked several buttons before the islands mount (%s), only the last one opens, so two surfaces never open at once",
    async (_order, clicked, last) => {
      // Given
      const chunk = stubChunk();
      const { ensureIslands } = await loadLoader();
      const loading = ensureIslands();

      // When
      for (const id of clicked) {
        click(byId(id));
      }
      chunk.arrive();
      await loading;

      // Then
      const received: Record<string, number> = {
        "theme-toggle": chunk.islandClicks(),
        "mode-button": chunk.settingsClicks(),
        "more-button": chunk.moreClicks(),
        "permissions-button": chunk.permissionsClicks(),
        "chains-button": chunk.chainsClicks(),
      };
      for (const [id, count] of Object.entries(received)) {
        expect(count, id).toBe(id === last ? 1 : 0);
      }
    },
  );

  it.each([
    ["a mouse click", 1],
    ["a key's click", 0],
  ])(
    "As a dotli user, the replayed click keeps the held one's detail (%s), so a menu opens as that click would have opened it",
    async (_kind, detail) => {
      // Given
      const chunk = stubChunk();
      const { ensureIslands } = await loadLoader();
      const loading = ensureIslands();

      // When
      click(byId("theme-toggle"), detail);
      chunk.arrive();
      await loading;

      // Then
      expect(chunk.islandClickDetails()).toEqual([detail]);
    },
  );

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

  it("As a mobile user, the More menu's Theme row tapped before the theme island mounts opens it once it does", async () => {
    // Given: the real More menu, mounted ahead of the theme island.
    const chunk = stubChunk();
    const { ensureIslands } = await loadLoader();
    unmountMore = mountMoreMenu();
    const loading = ensureIslands();

    // When
    await tapMoreRow("theme-toggle");
    chunk.arrive();
    await loading;

    // Then
    expect(chunk.islandClicks()).toBe(1);

    // When: the same row after the mount.
    await tapMoreRow("theme-toggle");

    // Then
    expect(chunk.islandClicks()).toBe(2);
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

  it("As a product, when the auth-modal island fails after it mounted, my pending login is cancelled and later logins are cancelled", async () => {
    // Given
    const chunk = stubChunk();
    const { ensureIslands } = await loadLoader();
    const auth = await initAuth();
    const loading = ensureIslands();
    await chunk.arrive();
    await loading;
    requestLogin();
    expect(auth.modalOpen()).toBe(true);
    const [onLateFailure] = chunk.mountIslands.mock.calls[0] as [
      (name: string) => void,
    ];

    // When
    onLateFailure("theme");

    // Then: another island failing leaves the login alone.
    expect(auth.modalOpen()).toBe(true);

    // When
    onLateFailure("auth-modal");

    // Then
    expect(auth.modalOpen()).toBe(false);
    expect(auth.cancels()).toBe(1);

    // When
    requestLogin();
    corePairing();

    // Then
    expect(auth.modalOpen()).toBe(false);
    expect(auth.loginRequests()).toBe(1);
  });

  it("As a user offline, when the banner island fails after it mounted and its static banner is back, the static banner follows the connection", async () => {
    // Given
    let online = true;
    vi.spyOn(navigator, "onLine", "get").mockImplementation(() => online);
    const chunk = stubChunk();
    const { ensureIslands } = await loadLoader();
    const staticBanner = byId("offline-banner");
    const loading = ensureIslands();
    await chunk.arrive();
    await loading;
    const [onLateFailure] = chunk.mountIslands.mock.calls[0] as [
      (name: string) => void,
    ];

    // When: the islands chunk puts the static banner back, as it does for a
    // late render error, and reports it.
    byId("offline-banner").replaceWith(staticBanner);
    onLateFailure("offline-banner");
    online = false;
    window.dispatchEvent(new Event("offline"));

    // Then
    expect(staticBanner.style.display).toBe("block");
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
