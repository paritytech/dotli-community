// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The shell islands loader (mount/load-islands.ts) against a stand-in chunk
// whose arrival each test controls. The real chunk is covered by
// tests/components/shell/islands.test.tsx.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock("@dotli/metrics/sentry", () => sentry);

const ISLANDS_CHUNK = "@dotli/ui/components/shell/islands";

interface Chunk {
  /** The chunk finishes loading. */
  arrive: () => void;
  /** The chunk fails to load. */
  fail: (err: unknown) => void;
  mountIslands: ReturnType<typeof vi.fn>;
  /** Clicks the island's (swapped-in) theme button received. */
  islandClicks: () => number;
}

/**
 * Stands in for the islands chunk: once it arrives, mountIslands swaps a
 * fresh theme button, which counts its clicks, in for the static one.
 */
function stubChunk(): Chunk {
  let arrive!: () => void;
  let fail!: (err: unknown) => void;
  const gate = new Promise<void>((resolve, reject) => {
    arrive = resolve;
    fail = reject;
  });
  let clicks = 0;
  const mountIslands = vi.fn(() => {
    const fresh = document.createElement("button");
    fresh.id = "theme-toggle";
    fresh.addEventListener("click", () => {
      clicks += 1;
    });
    document.getElementById("theme-toggle")?.replaceWith(fresh);
  });
  vi.doMock(ISLANDS_CHUNK, async () => {
    await gate;
    return { mountIslands };
  });
  return { arrive, fail, mountIslands, islandClicks: () => clicks };
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
  ].join("");
});

afterEach(() => {
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

  it("As a dotli user, when the islands chunk cannot load, the static shell stays, nothing is replayed and clicks are no longer held back", async () => {
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
    chunk.fail(err);

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

    // Then
    expect(after.defaultPrevented).toBe(false);
    expect(staticClicks).toHaveBeenCalledTimes(2);
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
  });
});
