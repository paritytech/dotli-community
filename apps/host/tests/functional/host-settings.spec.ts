// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Host shell settings: cache flags and chain backend selection.
 *
 * `skipWorkerCache` is not covered. The flag triggers an IDB purge sweep
 * in `apps/protocol/src/main.ts`, but the protocol-origin IDB it targets
 * is empty in practice. Smoldot does not auto-persist, polkadot-api uses
 * no IDB, and the `chains` store has no writers.
 *
 * Cross-tab speedup, when it exists, comes from the SharedWorker's
 * in-memory state in `smoldot-shared-worker` mode. That state lives in
 * RAM as long as at least one tab is open, and `skipWorkerCache` does
 * not touch it. Coverage of the flag is deferred until snapshot
 * persistence is wired up and the keep-set is narrowed to clear just
 * the `chains` store.
 *
 * Env overrides: DOMAIN, PORT, TIMEOUT_MS.
 */

import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { DOMAIN, PORT, TIMEOUT_MS } from "../env";
import { setupTest } from "./helpers/context";
import { waitForResolutionOutcome } from "../product-frame";
import {
  hasCachedCid,
  hostResolveStarted,
  sandboxArchiveCacheLookups,
  trackArchiveCacheLookups,
  waitForCachedCid,
} from "./helpers/cache";
import {
  BACKENDS,
  CACHE_ENABLED,
  SKIP_ARCHIVE_ONLY,
  SKIP_CID_ONLY,
  updateCacheSettings,
} from "./fixtures/settings";
import { test } from "./helpers/shared-mode-reset";

const BASE_URL = `http://${DOMAIN}.localhost:${PORT}/`;
const LANDING_URL = `http://localhost:${PORT}/`;
const FALLBACK_LABEL = "Light Client Shared unavailable";

test.setTimeout(BACKENDS.length * TIMEOUT_MS * 4);

interface ChainBackendState {
  chainBackend: string | null;
  cacheSettings: string | null;
  url: string;
}

async function readChainBackendState(
  page: Page,
  expected: string,
): Promise<ChainBackendState> {
  await page.waitForFunction(
    (e) => localStorage.getItem("dotli:chain-backend") === e,
    expected,
    { timeout: 10_000 },
  );
  return page.evaluate(() => ({
    chainBackend: localStorage.getItem("dotli:chain-backend"),
    cacheSettings: localStorage.getItem("dotli:cache-settings"),
    url: window.location.href,
  }));
}

async function disableSharedWorker(page: Page): Promise<void> {
  await page.addInitScript(() => {
    delete (window as unknown as { SharedWorker?: unknown }).SharedWorker;
  });
}

test.describe("Settings works", () => {
  test("As a first-time user, when I open an app it runs on its own smoldot instance for this tab", async ({
    page,
  }) => {
    // When
    await page.goto(LANDING_URL);

    // Then
    const state = await readChainBackendState(page, "smoldot-direct");
    expect(state.chainBackend).toBe("smoldot-direct");
  });

  test("As a first-time user on a browser without shared worker support, I get the same per-tab session", async ({
    page,
  }) => {
    // Given
    await disableSharedWorker(page);

    // When
    await page.goto(LANDING_URL);

    // Then
    const state = await readChainBackendState(page, "smoldot-direct");
    expect(state.chainBackend).toBe("smoldot-direct");
  });

  for (const backend of BACKENDS) {
    test(`As a user opening a link that selects ${backend}, my session runs in that mode and stays there`, async ({
      page,
    }) => {
      // When
      await page.goto(`${LANDING_URL}?chainBackend=${backend}`);

      // Then
      const state = await readChainBackendState(page, backend);
      expect(state.chainBackend).toBe(backend);
    });
  }

  test("As a user opening a link that selects a mode other than my saved one, the link wins and my session restarts in it", async ({
    page,
  }) => {
    // Given
    await page.addInitScript(() => {
      if (window.name !== "seeded") {
        localStorage.setItem("dotli:chain-backend", "rpc-gateway");
        window.name = "seeded";
      }
    });

    // When
    await page.goto(`${LANDING_URL}?chainBackend=smoldot-direct`);

    // Then
    const state = await readChainBackendState(page, "smoldot-direct");
    expect(state.chainBackend).toBe("smoldot-direct");
    expect(state.url).toContain("chainBackend=smoldot-direct");
  });

  test("As a user who arrived through such a link, reloading without it keeps me in the mode I landed in", async ({
    page,
  }) => {
    // Given
    await page.goto(`${LANDING_URL}?chainBackend=rpc-gateway`);
    await readChainBackendState(page, "rpc-gateway");

    // When
    await page.goto(LANDING_URL);

    // Then
    const state = await readChainBackendState(page, "rpc-gateway");
    expect(state.chainBackend).toBe("rpc-gateway");
    expect(state.url).toContain("chainBackend=rpc-gateway");
  });

  test("As a user running the default per-tab light client, my address bar stays clean", async ({
    page,
  }) => {
    // Given
    await page.addInitScript(() => {
      localStorage.setItem("dotli:chain-backend", "smoldot-direct");
    });

    // When
    await page.goto(LANDING_URL);

    // Then
    const state = await readChainBackendState(page, "smoldot-direct");
    expect(state.url).not.toContain("chainBackend=");
  });

  test("As a user on a browser without shared worker support, my address bar still stays clean", async ({
    page,
  }) => {
    // Given
    await page.addInitScript(() => {
      localStorage.setItem("dotli:chain-backend", "smoldot-direct");
      delete (window as unknown as { SharedWorker?: unknown }).SharedWorker;
    });

    // When
    await page.goto(LANDING_URL);

    // Then
    const state = await readChainBackendState(page, "smoldot-direct");
    expect(state.url).not.toContain("chainBackend=");
  });

  test("As a user who picked the shared light client, my address bar records it so a copied link carries it", async ({
    page,
  }) => {
    // Given
    await page.addInitScript(() => {
      localStorage.setItem("dotli:chain-backend", "smoldot-shared-worker");
    });

    // When
    await page.goto(LANDING_URL);

    // Then
    const state = await readChainBackendState(page, "smoldot-shared-worker");
    expect(state.url).toContain("chainBackend=smoldot-shared-worker");
  });

  test("As a user who picked trusted providers, my address bar records it on every visit", async ({
    page,
  }) => {
    // Given
    await page.addInitScript(() => {
      localStorage.setItem("dotli:chain-backend", "rpc-gateway");
    });

    // When
    await page.goto(LANDING_URL);

    // Then
    const state = await readChainBackendState(page, "rpc-gateway");
    expect(state.url).toContain("chainBackend=rpc-gateway");
  });

  test("As a user opening a link that turns caches off, those become my saved settings and stay in the link I can share", async ({
    page,
  }) => {
    // When
    await page.goto(
      `${LANDING_URL}?chainBackend=rpc-gateway&skipCidCache=1&skipArchiveCache=1&skipWorkerCache=0`,
    );

    // Then
    const state = await readChainBackendState(page, "rpc-gateway");
    expect(state.cacheSettings).not.toBeNull();
    const cache = JSON.parse(state.cacheSettings ?? "{}") as Record<
      string,
      unknown
    >;
    expect(cache.skipCidCache).toBe(true);
    expect(cache.skipArchiveCache).toBe(true);
    expect(cache.skipWorkerCache).toBe(false);
    expect(state.url).toContain("skipCidCache=1");
    expect(state.url).toContain("skipArchiveCache=1");
    expect(state.url).toContain("skipWorkerCache=0");
  });

  for (const backend of BACKENDS) {
    test(`As a user on ${backend} with the dotNS cache on, revisiting a site skips looking its name up again`, async ({
      browser,
    }) => {
      // Given
      const { context, page } = await setupTest(browser, {
        backend,
        cacheSeed: CACHE_ENABLED,
      });
      await page.goto(BASE_URL, { waitUntil: "commit" });
      await waitForResolutionOutcome(page, TIMEOUT_MS, backend);
      expect(await hostResolveStarted(page)).toBe(true);
      await waitForCachedCid(page, DOMAIN, 5_000);

      try {
        // When
        await page.reload({ waitUntil: "commit" });

        // Then
        await waitForResolutionOutcome(page, TIMEOUT_MS, backend);
        expect(await hostResolveStarted(page)).toBe(false);
      } finally {
        await context.close();
      }
    });

    test(`As a user on ${backend} who turns the dotNS cache off, every visit looks the name up again`, async ({
      browser,
    }) => {
      // Given
      const { context, page } = await setupTest(browser, {
        backend,
        cacheSeed: CACHE_ENABLED,
      });
      await page.goto(BASE_URL, { waitUntil: "commit" });
      await waitForResolutionOutcome(page, TIMEOUT_MS, backend);
      await waitForCachedCid(page, DOMAIN, 5_000);

      try {
        // When
        await updateCacheSettings(page, SKIP_CID_ONLY);
        await page.goto(BASE_URL, { waitUntil: "commit" });

        // Then
        await waitForResolutionOutcome(page, TIMEOUT_MS, backend);
        expect(await hostResolveStarted(page)).toBe(true);
        expect(await hasCachedCid(page, DOMAIN)).toBe(true);
      } finally {
        await context.close();
      }
    });
  }

  for (const backend of BACKENDS) {
    test(`As a user on ${backend} with the archive cache on, revisiting a site checks my local copy first`, async ({
      browser,
    }) => {
      // Given
      const { context, page } = await setupTest(browser, {
        backend,
        cacheSeed: CACHE_ENABLED,
      });
      await trackArchiveCacheLookups(context);
      await page.goto(BASE_URL, { waitUntil: "commit" });
      await waitForResolutionOutcome(page, TIMEOUT_MS, backend);

      try {
        // When
        await page.reload({ waitUntil: "commit" });

        // Then
        await waitForResolutionOutcome(page, TIMEOUT_MS, backend);
        expect(await sandboxArchiveCacheLookups(page)).toBeGreaterThan(0);
      } finally {
        await context.close();
      }
    });

    test(`As a user on ${backend} who turns the archive cache off, the site is fetched fresh instead of from my local copy`, async ({
      browser,
    }) => {
      // Given
      const { context, page } = await setupTest(browser, {
        backend,
        cacheSeed: SKIP_ARCHIVE_ONLY,
      });
      await trackArchiveCacheLookups(context);

      try {
        // When
        await page.goto(BASE_URL, { waitUntil: "commit" });

        // Then
        await waitForResolutionOutcome(page, TIMEOUT_MS, backend);
        expect(await sandboxArchiveCacheLookups(page)).toBe(0);
      } finally {
        await context.close();
      }
    });
  }
});

test.describe("Settings fails", () => {
  test("As a user opening a link with a garbled mode name, the app ignores it and gives me the default per-tab light client", async ({
    page,
  }) => {
    // When
    await page.goto(`${LANDING_URL}?chainBackend=foo`);

    // Then
    const state = await readChainBackendState(page, "smoldot-direct");
    expect(state.chainBackend).toBe("smoldot-direct");
    expect(state.url).not.toContain("chainBackend=foo");
  });

  test("As a user who chose the shared light client, opening the app in a browser without shared worker support moves me to a per-tab light client and tells me so", async ({
    page,
  }) => {
    // Given
    await page.addInitScript(() => {
      if (window.name !== "seeded") {
        localStorage.setItem("dotli:chain-backend", "smoldot-shared-worker");
        window.name = "seeded";
      }
      delete (window as unknown as { SharedWorker?: unknown }).SharedWorker;
    });

    // When
    await page.goto(LANDING_URL);

    // Then
    const state = await readChainBackendState(page, "smoldot-direct");
    expect(state.chainBackend).toBe("smoldot-direct");
    await expect(page.getByText(FALLBACK_LABEL)).toBeVisible();
  });

  test("As a user pasting a link that asks for the shared light client into a browser without shared worker support, the link is ignored and I'm told why", async ({
    page,
  }) => {
    // Given
    await disableSharedWorker(page);

    // When
    await page.goto(`${LANDING_URL}?chainBackend=smoldot-shared-worker`);

    // Then
    const state = await readChainBackendState(page, "smoldot-direct");
    expect(state.chainBackend).toBe("smoldot-direct");
    expect(state.url).not.toContain("chainBackend=smoldot-shared-worker");
    await expect(page.getByText(FALLBACK_LABEL)).toBeVisible();
  });

  test("As a user already on a per-tab light client, a browser without shared worker support changes nothing and says nothing", async ({
    page,
  }) => {
    // Given
    await page.addInitScript(() => {
      localStorage.setItem("dotli:chain-backend", "smoldot-direct");
      delete (window as unknown as { SharedWorker?: unknown }).SharedWorker;
    });

    // When
    await page.goto(LANDING_URL);

    // Then
    const state = await readChainBackendState(page, "smoldot-direct");
    expect(state.chainBackend).toBe("smoldot-direct");
    await expect(page.getByText(FALLBACK_LABEL)).not.toBeVisible();
  });
});
