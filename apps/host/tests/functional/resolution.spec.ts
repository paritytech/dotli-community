// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Cold resolution test against every supported backend, plus warm start
 * across a browser restart.
 *
 * Env overrides: DOMAIN, PORT, TIMEOUT_MS, WARM_DOMAIN
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect, type Page } from "@playwright/test";
import { DOMAIN, DOTNS_NAME, PORT, TIMEOUT_MS } from "../env";
import { setupTest } from "./helpers/context";
import { waitForResolutionOutcome } from "../product-frame";
import { BACKENDS, seedSettings } from "./fixtures/settings";
import { BROWSER_PERMISSIONS, seedPermissions } from "./fixtures/permissions";
import { test } from "./helpers/shared-mode-reset";

const BASE_URL = `http://${DOMAIN}.localhost:${PORT}/`;

/** A second product, so session 2 cannot be answered from the content cache. */
const WARM_DOMAIN = process.env.WARM_DOMAIN ?? "browse";
const WARM_BASE_URL = `http://${WARM_DOMAIN}.localhost:${PORT}/`;
/** The provider's smoldot database store, on the protocol iframe's origin. */
const PROTOCOL_ORIGIN = `http://host.localhost:${PORT}`;
/** Long enough for the provider to write its first warm-start blob to IndexedDB. */
const SNAPSHOT_WINDOW_MS = 35_000;

test.setTimeout(BACKENDS.length * TIMEOUT_MS * 2);

test.describe("Resolution across chain backends", () => {
  for (const backend of BACKENDS) {
    test(`As a user opening ${DOTNS_NAME} via ${backend}, the shell loads the app`, async ({
      browser,
    }) => {
      // Given
      const { context, page } = await setupTest(browser, { backend });

      try {
        // When
        await page.goto(BASE_URL, { waitUntil: "commit" });

        // Then
        await waitForResolutionOutcome(page, TIMEOUT_MS, backend);
      } finally {
        await context.close();
      }
    });
  }

  test(`As a user opening ${DOMAIN}.dot, I am shown how many peers the light client found`, async ({
    browser,
  }) => {
    // Given
    const { context, page } = await setupTest(browser, {
      backend: "smoldot-direct",
    });

    try {
      // Record the counts as they reach the shell. The rendered figure can
      // change faster than a poll can catch, so the envelope is the reliable
      // signal and the visible readout is accepted as an alternative.
      await page.addInitScript(() => {
        const seen: unknown[] = [];
        (
          window as unknown as { __dotliPeerCounts: unknown[] }
        ).__dotliPeerCounts = seen;
        window.addEventListener("message", (event: MessageEvent) => {
          const data = event.data as {
            namespace?: string;
            kind?: string;
            syncKind?: string;
            peers?: number;
          } | null;
          if (
            data !== null &&
            typeof data === "object" &&
            data.namespace === "dotli:protocol" &&
            data.kind === "chain-sync" &&
            data.syncKind === "peers" &&
            typeof data.peers === "number"
          ) {
            seen.push(data);
          }
        });
      });

      // When
      await page.goto(BASE_URL, { waitUntil: "commit" });

      // Then
      const sawPeers = page.waitForFunction(
        () => {
          const seen = (window as unknown as { __dotliPeerCounts?: unknown[] })
            .__dotliPeerCounts;
          if (seen !== undefined && seen.length > 0) {
            return true;
          }
          return ["relay", "assethub", "bulletin"].some((chain) =>
            /[1-9]/.test(
              document.getElementById(`metric-peers-${chain}`)?.textContent ??
                "",
            ),
          );
        },
        undefined,
        { timeout: TIMEOUT_MS },
      );
      await Promise.all([
        sawPeers,
        waitForResolutionOutcome(page, TIMEOUT_MS, "smoldot-direct"),
      ]);
    } finally {
      await context.close();
    }
  });
});

interface SmoldotDbState {
  /** Genesis hash of every chain with a stored database blob. */
  stored: string[];
  /** Genesis hash of every chain the provider resumed from storage. */
  loaded: string[];
}

/**
 * Read the provider's smoldot database store from the protocol iframe.
 *
 * The store lives on the protocol origin rather than the product's, and in
 * the default backend the provider writes it from a SharedWorker, so this is
 * the only vantage point the test has on warm start.
 */
async function readSmoldotDb(page: Page): Promise<SmoldotDbState> {
  const frame = page.frames().find((f) => f.url().startsWith(PROTOCOL_ORIGIN));
  if (frame === undefined) {
    throw new Error(`no protocol frame at ${PROTOCOL_ORIGIN}`);
  }
  return frame.evaluate(async () => {
    const keys = (db: IDBDatabase, store: string): Promise<string[]> =>
      new Promise((resolve, reject) => {
        if (!db.objectStoreNames.contains(store)) {
          resolve([]);
          return;
        }
        const req = db
          .transaction(store, "readonly")
          .objectStore(store)
          .getAllKeys();
        req.onsuccess = () => {
          resolve(req.result.map(String));
        };
        req.onerror = () => {
          reject(req.error ?? new Error(`read ${store} failed`));
        };
      });

    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("dotli-smoldot-db");
      req.onsuccess = () => {
        resolve(req.result);
      };
      req.onerror = () => {
        reject(req.error ?? new Error("open smoldot-db failed"));
      };
    });
    try {
      return {
        stored: await keys(db, "chain-databases"),
        loaded: await keys(db, "loads"),
      };
    } finally {
      db.close();
    }
  });
}

/**
 * Open a session against `profile`, resolve `url`, then hand the page to `run`.
 *
 * The profile directory is locked while a context holds it, so each session
 * must close before the next one opens against the same profile.
 */
async function withWarmSession<T>(
  profile: string,
  url: string,
  label: string,
  run: (page: Page) => Promise<T>,
): Promise<T> {
  const context = await chromium.launchPersistentContext(profile, {
    permissions: [...BROWSER_PERMISSIONS],
  });
  try {
    await seedPermissions(context);
    await seedSettings(context, { backend: "smoldot-shared-worker" });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "commit" });
    await waitForResolutionOutcome(page, TIMEOUT_MS, label);
    return await run(page);
  } finally {
    await context.close();
  }
}

test.describe("Warm start across a browser restart", () => {
  test.setTimeout(SNAPSHOT_WINDOW_MS + TIMEOUT_MS * 3);

  test(`As a user returning after quitting the browser, ${WARM_DOMAIN} resumes the light client from stored state`, async () => {
    const profile = mkdtempSync(join(tmpdir(), "dotli-warm-"));
    try {
      // Given
      const primed = await withWarmSession(
        profile,
        BASE_URL,
        "warm start, session 1",
        async (page) => {
          await page.waitForTimeout(SNAPSHOT_WINDOW_MS);
          return readSmoldotDb(page);
        },
      );
      expect(primed.stored, "session 1 stored no database blobs").not.toEqual(
        [],
      );
      expect(primed.loaded, "session 1 had nothing to resume from").toEqual([]);

      // When
      const resumed = await withWarmSession(
        profile,
        WARM_BASE_URL,
        "warm start, session 2",
        readSmoldotDb,
      );

      // Then
      expect(
        resumed.loaded,
        "session 2 resumed no chain from storage",
      ).not.toEqual([]);
      expect(primed.stored).toEqual(expect.arrayContaining(resumed.loaded));
    } finally {
      rmSync(profile, { recursive: true, force: true });
    }
  });
});
