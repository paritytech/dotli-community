// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Cold resolution test against every supported backend.
 *
 * Env overrides: DOMAIN, PORT, TIMEOUT_MS
 */

import { DOMAIN, PORT, TIMEOUT_MS } from "../env";
import { setupTest } from "./helpers/context";
import { waitForResolutionOutcome } from "../product-frame";
import { BACKENDS } from "./fixtures/settings";
import { test } from "./helpers/shared-mode-reset";

const BASE_URL = `http://${DOMAIN}.localhost:${PORT}/`;

test.setTimeout(BACKENDS.length * TIMEOUT_MS * 2);

test.describe("Resolution across chain backends", () => {
  for (const backend of BACKENDS) {
    test(`As a user opening ${DOMAIN}.dot via ${backend}, the shell loads the app`, async ({
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

  test(`As a user opening ${DOMAIN}.dot, I am told how many peers the light client found while it syncs`, async ({
    browser,
  }) => {
    // Given
    const { context, page } = await setupTest(browser, {
      backend: "smoldot-direct",
    });

    try {
      // Record the counts as they reach the shell. On a fast bootstrap the
      // rendered "N peers" line can appear and clear between polls, so the
      // count itself is the reliable signal. The visible text is accepted
      // as an alternative when the sync window is long enough to show it.
      await page.addInitScript(() => {
        const seen: unknown[] = [];
        (
          window as unknown as { __dotliHealthSeen: unknown[] }
        ).__dotliHealthSeen = seen;
        window.addEventListener("message", (event: MessageEvent) => {
          const data = event.data as {
            namespace?: string;
            kind?: string;
            peers?: number;
          } | null;
          if (
            data !== null &&
            typeof data === "object" &&
            data.namespace === "dotli:protocol" &&
            data.kind === "health" &&
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
          const seen = (window as unknown as { __dotliHealthSeen?: unknown[] })
            .__dotliHealthSeen;
          if (seen !== undefined && seen.length > 0) {
            return true;
          }
          return /\d+ peers?/.test(
            document.getElementById("loading-detail")?.textContent ?? "",
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
