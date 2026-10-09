// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { test as base } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';
import { PORT } from '../../env.js';

/**
 * Wipes the preview server's process-wide mode-sync store, or a sibling spec's `rpc-gateway` write silently
 * reroutes this test through RPC. Hits 127.0.0.1 because Node on Linux CI does not resolve `*.localhost`.
 */
export async function resetSharedMode(request: APIRequestContext): Promise<void> {
  const res = await request.delete(`http://127.0.0.1:${PORT}/__dotli-mode/`);
  if (!res.ok()) {
    throw new Error(`[shared-mode-reset] preview-server returned HTTP ${String(res.status())}`);
  }
}

/** On in debug builds, the panel's docked filter bar overlaps controls the tests click. */
async function disableTruapiDebugPanel(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      sessionStorage.setItem('dotli:truapi-debug', '0');
      // eslint-disable-next-line no-restricted-syntax -- sessionStorage may be unavailable in exotic init contexts; fixture is best-effort.
    } catch {
      /* ignore */
    }
  });
}

/** Specs that seed `dotli:chain-backend` must import `test` from here. */
export const test = base.extend<{ _resetSharedMode: undefined }>({
  _resetSharedMode: [
    async ({ request, page }, use) => {
      await resetSharedMode(request);
      await disableTruapiDebugPanel(page);
      await use(undefined);
    },
    { auto: true },
  ],
});
