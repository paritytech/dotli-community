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

test.describe("Cache settings", () => {
  for (const backend of BACKENDS) {
    test(`As a user with the CID cache enabled via ${backend}, the shell serves the CID from cache on revisit`, async ({
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

    test(`As a user with the CID cache disabled via ${backend}, the shell re-resolves on every visit`, async ({
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
    test(`As a user with the archive cache enabled via ${backend}, the sandbox consults the SW archive cache on every visit`, async ({
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

    test(`As a user with the archive cache disabled via ${backend}, the sandbox skips the SW archive cache lookup`, async ({
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

  test("As a user opening the host with URL cache flags, the skip-flags persist to `dotli:cache-settings` and non-default values survive URL canonicalisation", async ({
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
});

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

test.describe("Chain backend × URL persistence", () => {
  for (const backend of BACKENDS) {
    test(`As a user, when I open the app with ?chainBackend=${backend}, the choice is persisted to localStorage`, async ({
      page,
    }) => {
      // When
      await page.goto(`${LANDING_URL}?chainBackend=${backend}`);

      // Then
      const state = await readChainBackendState(page, backend);
      expect(state.chainBackend).toBe(backend);
    });
  }

  test("As a user, when I open the app with ?chainBackend=foo (unknown), the value is ignored and the default backend is persisted instead", async ({
    page,
  }) => {
    // When
    await page.goto(`${LANDING_URL}?chainBackend=foo`);

    // Then
    const state = await readChainBackendState(page, "smoldot-shared-worker");
    expect(state.chainBackend).toBe("smoldot-shared-worker");
    expect(state.url).not.toContain("chainBackend=foo");
  });

  test("As a user, when I open the app with a URL chainBackend that differs from my persisted choice, the URL value wins after a wipe+reload", async ({
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

  test("As a user, after a URL-driven set, a plain reload without URL params keeps the chosen backend", async ({
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
});

test.describe("Chain backend × SharedWorker availability", () => {
  test("As a user on a SharedWorker-capable browser, opening the app for the first time defaults the backend to smoldot-shared-worker", async ({
    page,
  }) => {
    // When
    await page.goto(LANDING_URL);

    // Then
    const state = await readChainBackendState(page, "smoldot-shared-worker");
    expect(state.chainBackend).toBe("smoldot-shared-worker");
  });

  test("As a user on a browser without SharedWorker, opening the app for the first time falls back to smoldot-direct", async ({
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

  test("As a user with a persisted smoldot-shared-worker preference, opening the app in a browser without SharedWorker downgrades the backend to smoldot-direct with a fallback notification", async ({
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

  test("As a user pasting a ?chainBackend=smoldot-shared-worker URL into a browser without SharedWorker, the URL value is ignored and the fallback notification appears", async ({
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

  test("As a user with a persisted smoldot-direct preference, opening the app in a browser without SharedWorker is silent — no fallback notification fires", async ({
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

test.describe("Chain backend × URL canonicalisation", () => {
  test("As a user on a SharedWorker-capable browser with the default backend persisted, the URL stays clean", async ({
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
    expect(state.url).not.toContain("chainBackend=");
  });

  test("As a user on a browser without SharedWorker with smoldot-direct persisted, the URL stays clean", async ({
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

  test("As a user on a SharedWorker-capable browser with rpc-gateway persisted, the URL is canonicalised to mirror the non-default choice on every visit", async ({
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
});
