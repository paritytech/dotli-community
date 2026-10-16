// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, type Page, type Frame } from '@playwright/test';

type PageLike = Page | Frame;

// The playground prepends new log entries, so the newest is `.first()`.

export async function waitForPlaygroundReady(page: PageLike, timeout = 60_000): Promise<void> {
  await expect(page.locator('h1:has-text("Host Playground")').first()).toBeVisible({ timeout });
}

/** Runs one playground test. A stuck entry returns "error" rather than throwing, so one hung test skips no others. */
export async function runTest(page: PageLike, testId: string, timeout = 20_000): Promise<'success' | 'error'> {
  const entries = page.locator('[data-testid="log-entry"]');
  const initialCount = await entries.count();

  const btn = page.locator(`[data-testid="run-${testId}"]`);
  await expect(btn).toBeVisible({ timeout: 10_000 });

  try {
    await expect(btn).toBeEnabled({ timeout: 5_000 });
  } catch {
    console.log(`[host-playground] ${testId}: DISABLED`);
    return 'error';
  }

  await btn.click();

  await expect.poll(async () => entries.count(), { timeout: 10_000 }).toBeGreaterThan(initialCount);

  const newest = entries.first();
  try {
    await expect(newest).not.toHaveAttribute('data-status', 'pending', {
      timeout,
    });
  } catch {
    console.log(`[host-playground] ${testId}: STUCK PENDING`);
    return 'error';
  }

  const status = await newest.getAttribute('data-status');
  console.log(`[host-playground] ${testId}: ${status === 'success' ? 'OK' : 'FAILED'}`);
  return status === 'success' ? 'success' : 'error';
}

export async function runTestExpectSuccess(page: PageLike, testId: string, timeout = 20_000): Promise<void> {
  expect(await runTest(page, testId, timeout)).toBe('success');
}

export async function runTestExpectError(page: PageLike, testId: string, timeout = 20_000): Promise<void> {
  expect(await runTest(page, testId, timeout)).toBe('error');
}
