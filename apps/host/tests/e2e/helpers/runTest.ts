// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, type Page, type Frame, type Locator } from '@playwright/test';

type PageLike = Page | Frame;

// The playground prepends new log entries, so the newest is `.first()`.

/** The entry's text on one line, which carries the product's own reason. Empty when the frame went away. */
export async function entryText(entry: Locator): Promise<string> {
  const text = await entry.innerText({ timeout: 2_000 }).catch(() => '');
  return text.replace(/\s+/g, ' ').trim().slice(0, 500);
}

/** The status a playground test ended with, and its entry's text. */
type RunResult = { status: 'success' | 'error'; text: string };

/** Runs one playground test. A stuck entry returns "error" rather than throwing, so one hung test skips no others. */
export async function runTest(page: PageLike, testId: string, timeout = 20_000): Promise<RunResult> {
  const entries = page.locator('[data-testid="log-entry"]');
  const initialCount = await entries.count();

  const btn = page.locator(`[data-testid="run-${testId}"]`);
  await expect(btn).toBeVisible({ timeout: 10_000 });

  try {
    await expect(btn).toBeEnabled({ timeout: 5_000 });
  } catch {
    console.log(`[host-playground] ${testId}: DISABLED`);
    return { status: 'error', text: '' };
  }

  await btn.click();

  await expect.poll(async () => entries.count(), { timeout: 10_000 }).toBeGreaterThan(initialCount);

  const newest = entries.first();
  try {
    await expect(newest).not.toHaveAttribute('data-status', 'pending', {
      timeout,
    });
  } catch {
    const text = await entryText(newest);
    console.log(`[host-playground] ${testId}: STUCK PENDING ${text}`);
    return { status: 'error', text };
  }

  const status = (await newest.getAttribute('data-status')) === 'success' ? 'success' : 'error';
  const text = await entryText(newest);
  console.log(`[host-playground] ${testId}: ${status === 'success' ? 'OK' : `FAILED ${text}`}`);
  return { status, text };
}

export async function runTestExpectSuccess(page: PageLike, testId: string, timeout = 20_000): Promise<void> {
  expect((await runTest(page, testId, timeout)).status).toBe('success');
}
