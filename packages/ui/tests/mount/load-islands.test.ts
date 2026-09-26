// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The shell islands loader (mount/load-islands.ts) against a stand-in chunk
// whose arrival each test controls. The real chunk is covered by
// tests/components/shell/islands.test.tsx.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock("@dotli/metrics/sentry", () => sentry);

const ISLANDS_CHUNK = "@dotli/ui/components/shell/islands";

/** How long the loader waits before retrying a failed chunk load. */
const RETRY_DELAY_MS = 1000;

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
}

/** Lets pending I/O and promise callbacks run (timers stay faked). */
function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Stands in for the islands chunk: each import waits until the test lets it
 * arrive or fail; once it arrives, mountIslands swaps a fresh theme button,
 * which counts its clicks, in for the static one.
 */
function stubChunk(mountError?: Error): Chunk {
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
  const mountIslands = vi.fn(() => {
    if (mountError !== undefined) {
      throw mountError;
    }
    const fresh = document.createElement("button");
    fresh.id = "theme-toggle";
    fresh.addEventListener("click", () => {
      clicks += 1;
    });
    document.getElementById("theme-toggle")?.replaceWith(fresh);
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
  };
}

async function loadLoader(): Promise<
  typeof import("@dotli/ui/mount/load-islands")
> {
  return import("@dotli/ui/mount/load-islands");
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

beforeEach(() => {
  vi.resetModules();
  document.body.innerHTML = [
    '<button id="theme-toggle" class="topbar-btn"><svg><path d="M0 0"/></svg></button>',
    '<div id="theme-popover" class="more-popover theme-popover"></div>',
    '<button id="other" type="button">Other</button>',
    '<button class="more-row" data-target="theme-toggle">Theme</button>',
  ].join("");
});

afterEach(() => {
  vi.useRealTimers();
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

  it("As a dotli user on a flaky connection, when the islands chunk fails to load once, the retry mounts the islands and my early click still opens the menu", async () => {
    // Given
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const chunk = stubChunk();
    const { ensureIslands } = await loadLoader();
    const loading = ensureIslands();
    click(byId("theme-toggle"));

    // When: the first load fails.
    await chunk.fail(new Error("chunk failed"));
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS - 1);

    // Then: no retry yet, and clicks are still held back.
    expect(chunk.imports()).toBe(1);
    expect(sentry.captureException).not.toHaveBeenCalled();
    expect(click(byId("theme-toggle")).defaultPrevented).toBe(true);

    // When: the retry starts and succeeds.
    await vi.advanceTimersByTimeAsync(1);
    await chunk.arrive();
    await loading;

    // Then
    expect(chunk.imports()).toBe(2);
    expect(chunk.mountIslands).toHaveBeenCalledTimes(1);
    expect(chunk.islandClicks()).toBe(1);
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it("As a dotli user, when the islands chunk cannot load even on the retry, the static shell stays, the failure is reported once, nothing is replayed and clicks are no longer held back", async () => {
    // Given
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const chunk = stubChunk();
    const { ensureIslands } = await loadLoader();
    const staticButton = byId("theme-toggle");
    const staticClicks = vi.fn();
    staticButton.addEventListener("click", staticClicks);
    const loading = ensureIslands();
    click(staticButton);
    const err = new Error("chunk failed again");

    // When
    await chunk.fail(new Error("chunk failed"));
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS);
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
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS * 2);

    // Then: no third attempt.
    expect(after.defaultPrevented).toBe(false);
    expect(staticClicks).toHaveBeenCalledTimes(2);
    expect(chunk.imports()).toBe(2);
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
    const chunk = stubChunk(err);
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
});
