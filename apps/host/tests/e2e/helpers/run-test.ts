// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, type Page, type Frame, type Locator } from "@playwright/test";

type PageLike = Page | Frame;

/**
 * host-playground product helpers. Works against either Page (top-level) or
 * Frame (the host-playground iframe inside dot.li). New log entries are
 * prepended (useLogs.ts), so the newest is .first().
 */

export async function waitForPlaygroundReady(
  page: PageLike,
  timeout = 60_000,
): Promise<void> {
  await expect(
    page.locator('h1:has-text("Host Playground")').first(),
  ).toBeVisible({ timeout });
}

// Centre the card first: one clipped at the frame's bottom edge is clicked on
// the seam under the host's debug dock, which swallows the click.
export async function clickRunButton(btn: Locator): Promise<void> {
  await btn.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await btn.click();
}

/**
 * Click run-<testId>, wait for a new log entry, return its data-status.
 * Returns "error" rather than throwing on stuck-pending so a single hung
 * test doesn't cascade-skip the rest.
 */
export async function runTest(
  page: PageLike,
  testId: string,
  timeout = 20_000,
): Promise<"success" | "error"> {
  const entries = page.locator('[data-testid="log-entry"]');
  const initialCount = await entries.count();

  const btn = page.locator(`[data-testid="run-${testId}"]`);
  await expect(btn).toBeVisible({ timeout: 10_000 });

  try {
    await expect(btn).toBeEnabled({ timeout: 5_000 });
  } catch {
    console.log(`[host-playground] ${testId}: DISABLED`);
    return "error";
  }

  await clickRunButton(btn);

  await expect
    .poll(async () => entries.count(), { timeout: 10_000 })
    .toBeGreaterThan(initialCount);

  const newest = entries.first();
  try {
    await expect(newest).not.toHaveAttribute("data-status", "pending", {
      timeout,
    });
  } catch {
    console.log(`[host-playground] ${testId}: STUCK PENDING`);
    return "error";
  }

  const status = await newest.getAttribute("data-status");
  console.log(
    `[host-playground] ${testId}: ${status === "success" ? "OK" : "FAILED"}`,
  );
  return status === "success" ? "success" : "error";
}

export async function runTestExpectSuccess(
  page: PageLike,
  testId: string,
  timeout = 20_000,
): Promise<void> {
  expect(await runTest(page, testId, timeout)).toBe("success");
}

export async function runTestExpectError(
  page: PageLike,
  testId: string,
  timeout = 20_000,
): Promise<void> {
  expect(await runTest(page, testId, timeout)).toBe("error");
}
