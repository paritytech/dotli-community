// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { test as base } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";

const PORT = process.env.COMBO_PORT ?? "5173";

/**
 * Wipe the preview-server's process-wide mode-sync `Map` (see
 * `scripts/preview-server.ts`). Required between tests: a sibling spec's
 * `rpc-gateway` write shadows this test's per-context `localStorage` seed
 * during bootstrap, silently rerouting the host through the RPC path
 * (where mocked iframes are never queried, the 10s-timeout failure shape).
 *
 * Hits `127.0.0.1` directly: Chromium resolves `*.localhost` to 127.0.0.1,
 * but Node's default DNS resolver on Linux (the CI runner) does not, so
 * `host.localhost:PORT` here would ECONNREFUSED on CI. The mode-sync
 * endpoint gates on path, not hostname, so this is safe.
 */
export async function resetSharedMode(
  request: APIRequestContext,
): Promise<void> {
  const res = await request.delete(`http://127.0.0.1:${PORT}/__dotli-mode/`);
  if (!res.ok()) {
    throw new Error(
      `[shared-mode-reset] preview-server returned HTTP ${String(res.status())}`,
    );
  }
}

/**
 * Disable the TrUAPI debug panel for the page's lifetime. The panel is
 * on-by-default on the `debug-panel-system-events` branch (and in any
 * debug build), and its docked filter bar overlaps content the tests
 * try to click (e.g. `#error-retry-btn`), causing "pointer events
 * intercepted" failures. Tests should exercise the production-like
 * UI surface, so we set the panel's persisted sessionStorage flag to
 * `"0"` before any page script runs.
 */
async function disableTruapiDebugPanel(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      sessionStorage.setItem("dotli:truapi-debug", "0");
      // eslint-disable-next-line no-restricted-syntax -- sessionStorage may be unavailable in exotic init contexts; fixture is best-effort.
    } catch {
      /* ignore */
    }
  });
}

/**
 * Drop-in replacement for `@playwright/test`'s `test` that:
 *   1. auto-resets the shared mode-sync store before every test
 *   2. auto-disables the TrUAPI debug panel for every page
 * Specs that seed `dotli:chain-backend` in `localStorage` should
 * import `test` from here.
 */
export const test = base.extend<{ _resetSharedMode: void }>({
  _resetSharedMode: [
    async ({ request, page }, use) => {
      await resetSharedMode(request);
      await disableTruapiDebugPanel(page);
      await use();
    },
    { auto: true },
  ],
});
