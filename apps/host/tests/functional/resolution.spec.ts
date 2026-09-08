// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Cold resolution test against every supported backend, plus warm start
 * across a browser restart.
 *
 * Env overrides: DOMAIN, PORT, TIMEOUT_MS, WARM_DOMAIN, WARM_BUDGET_MS
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";
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
const WARM_BUDGET_MS = parseInt(process.env.WARM_BUDGET_MS ?? "2000", 10);
/** The old `smoldot-db` wrote its first snapshot 30s after a chain was added. */
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
});

test.describe("Warm start across a browser restart", () => {
  test.setTimeout(SNAPSHOT_WINDOW_MS + TIMEOUT_MS * 3);

  test(`As a user returning after quitting the browser, ${WARM_DOMAIN} resolves from persisted light-client state`, async () => {
    // Expected to fail until the provider persists a warm-start blob: it never
    // calls the crate's snapshot()/setDatabase(), so every session warp-syncs
    // from scratch.
    test.fail();

    const profile = mkdtempSync(join(tmpdir(), "dotli-warm-"));
    try {
      // Given
      const first = await chromium.launchPersistentContext(profile, {
        permissions: [...BROWSER_PERMISSIONS],
      });
      try {
        await seedPermissions(first);
        await seedSettings(first, { backend: "smoldot-shared-worker" });
        const page = await first.newPage();
        await page.goto(BASE_URL, { waitUntil: "commit" });
        await waitForResolutionOutcome(
          page,
          TIMEOUT_MS,
          "warm start, session 1",
        );
        await page.waitForTimeout(SNAPSHOT_WINDOW_MS);
      } finally {
        await first.close();
      }

      // When
      const second = await chromium.launchPersistentContext(profile, {
        permissions: [...BROWSER_PERMISSIONS],
      });
      try {
        await seedPermissions(second);
        await seedSettings(second, { backend: "smoldot-shared-worker" });
        const page = await second.newPage();
        await page.goto(WARM_BASE_URL, { waitUntil: "commit" });
        await waitForResolutionOutcome(
          page,
          TIMEOUT_MS,
          "warm start, session 2",
        );

        // Then
        const resolveMs = await page.evaluate(() => {
          const at = (name: string): number | undefined =>
            performance.getEntriesByName(name, "mark").at(0)?.startTime;
          const start = at("dotli:resolve:start");
          const end = at("dotli:resolve:end");
          return start === undefined || end === undefined
            ? null
            : Math.round(end - start);
        });

        expect(resolveMs, "session 2 emitted no resolve marks").not.toBeNull();
        expect(resolveMs).toBeLessThan(WARM_BUDGET_MS);
      } finally {
        await second.close();
      }
    } finally {
      rmSync(profile, { recursive: true, force: true });
    }
  });
});
