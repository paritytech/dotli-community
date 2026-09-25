// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Deployment-level TrUAPI coverage.
//
// The paired E2E suite exercises every capability, but only against a
// locally built host: it spawns and pairs the signing-host CLI and talks to
// `*.localhost`. Nothing there loads the deployed bundle, so a deployment
// could serve a host that cannot talk to the published products at all —
// which is exactly how a product/host protocol mismatch stayed invisible
// until someone opened the site.
//
// This suite closes that gap with the capabilities that need no wallet:
// they run against the deployed host and the published host-playground
// executable, with no signer, no pairing, and no chain writes. Capabilities
// that require a session (product accounts, entropy derivation, authorized
// statement proofs, account balance) stay in the paired E2E suite; asserting
// them here would only re-test the signing host.

import { expect, test, type FrameLocator, type Page } from "@playwright/test";

const root = process.env.DOTLI_SMOKE_ROOT ?? "westendli.dev";
if (!/^[a-z0-9.-]+$/.test(root)) {
  throw new Error(`DOTLI_SMOKE_ROOT is not a valid host suffix: ${root}`);
}

/**
 * host-playground checks that resolve without a signed-in wallet. Grouped
 * by the surface they prove reaches the deployed host: a product that
 * handshakes but cannot read the chain fails here, and so does a host whose
 * storage or subscription plumbing did not survive the deployment.
 */
const WALLET_FREE_CHECKS: readonly string[] = [
  // Handshake and host metadata.
  "feature-check",
  "well-known-chains",
  "theme-subscribe",
  // Product-scoped storage, entirely host-side.
  "storage-string-write-read",
  "storage-bytes-write-read",
  "storage-json-write-read",
  "storage-clear",
  "storage-factory",
  // Chain reads through whichever backend the deployment serves.
  "chain-spec-genesis-hash",
  "chain-spec-chain-name",
  "chain-spec-properties",
  "contract-query-stored-value",
  "contract-query-data-length",
  "contract-query-balance",
  "contract-query-total-deposits",
  "preimage-lookup",
  // Statement Store reads and live subscriptions.
  "statement-store-subscribe-match-all",
  "statement-store-subscribe-match-any",
  // Host navigation.
  "navigate-http",
];

const CHECK_TIMEOUT_MS = 25_000;

async function openPlayground(page: Page): Promise<FrameLocator> {
  const selector = `iframe[src*="host-playground.app.${root}"]`;
  await page.goto(`https://host-playground.${root}/?chainBackend=rpc-gateway`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await expect(page.locator(selector)).toBeAttached({ timeout: 180_000 });
  const frame = page.frameLocator(selector);
  // The product renders its own heading, so this also proves the sandbox
  // booted and completed the TrUAPI handshake with the deployed host.
  await expect(
    frame.locator('h1:has-text("Host Playground")').first(),
  ).toBeVisible({ timeout: 120_000 });
  return frame;
}

/** Run one playground check and report the log entry's final status. */
async function runCheck(
  page: Page,
  frame: FrameLocator,
  testId: string,
): Promise<string> {
  const entries = frame.locator('[data-testid="log-entry"]');
  const before = await entries.count();
  const button = frame.locator(`[data-testid="run-${testId}"]`);
  if (!(await button.isVisible().catch(() => false))) {
    return "absent";
  }
  if (!(await button.isEnabled().catch(() => false))) {
    return "disabled";
  }
  await button.click();

  // New entries are prepended, so the newest is first. Poll rather than
  // assert so one hung capability reports itself instead of ending the run.
  const deadline = Date.now() + CHECK_TIMEOUT_MS;
  let status = "no-entry";
  while (Date.now() < deadline) {
    if ((await entries.count()) > before) {
      const current = await entries.first().getAttribute("data-status");
      if (current !== null && current !== "pending") {
        return current;
      }
      status = "pending";
    }
    await page.waitForTimeout(250);
  }
  return status;
}

test("published host-playground capabilities work on the deployment", async ({
  page,
}) => {
  test.setTimeout(600_000);

  // Given: the deployed host serving the published playground executable.
  const frame = await openPlayground(page);

  // When: every wallet-free capability runs against it.
  const failures: string[] = [];
  for (const testId of WALLET_FREE_CHECKS) {
    const status = await runCheck(page, frame, testId);
    console.log(`[${root}] ${testId}: ${status}`);
    if (status !== "success") {
      failures.push(`${testId}=${status}`);
    }
  }

  // Then: none of them degraded on this deployment.
  expect(failures, `failed capabilities on ${root}`).toEqual([]);
});
