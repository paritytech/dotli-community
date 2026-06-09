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
});
