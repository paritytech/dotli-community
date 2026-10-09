// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, type Page, type Frame, type Locator } from '@playwright/test';

type PageLike = Page | Frame;

/** A test authorizes a specific kind of host review, never any matching button on the page. */
export interface HostDialogDecision {
  title: string;
  button: string;
}

/** The signing-host CLI signs once the SignRequest reaches the Statement Store, so only host dialogs need clicks. */
export async function runWebSignedTest(
  hostPage: Page,
  productFrame: PageLike,
  testId: string,
  dialogs: readonly HostDialogDecision[],
  opts: { timeoutMs?: number; preClickDelayMs?: number } = {},
): Promise<'success' | 'error'> {
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const preClickDelayMs = opts.preClickDelayMs ?? 0;
  const entries = productFrame.locator('[data-testid="log-entry"]');
  const initialCount = await entries.count();

  const btn = productFrame.locator(`[data-testid="run-${testId}"]`);
  await expect(btn).toBeVisible({ timeout: 10_000 });
  try {
    await expect(btn).toBeEnabled({ timeout: 15_000 });
  } catch {
    console.log(`[signed] ${testId}: DISABLED`);
    return 'error';
  }
  console.log(`[signed] ${testId}: clicking run`);
  await btn.click();

  const dialogController = new AbortController();
  const dialogTask =
    dialogs.length > 0
      ? clickHostDialogs(hostPage, dialogs, 60_000, preClickDelayMs, dialogController.signal)
      : Promise.resolve();

  const resultTask = waitForLogResult(entries, initialCount, testId, timeoutMs);
  let result: 'success' | 'error';
  try {
    result = await Promise.race([resultTask, dialogTask.then(() => resultTask)]);
  } finally {
    dialogController.abort();
    await dialogTask;
  }
  if (result === 'error') {
    // Shows a dialog selector mismatch, where the signer signed but no Allow or Sign button was found.
    const visibleButtons = await hostPage
      .locator('button:visible')
      .evaluateAll(els => els.map(e => e.textContent.trim().slice(0, 60)).filter(Boolean))
      .catch(() => []);
    console.log(`[signed] ${testId}: visible buttons on host: ${JSON.stringify(visibleButtons)}`);
  }
  return result;
}

/** Handles only the current test's declared reviews until its result or the existing dialog deadline. */
async function clickHostDialogs(
  page: Page,
  dialogs: readonly HostDialogDecision[],
  timeoutMs: number,
  preClickDelayMs: number,
  signal: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const seen = new Set<string>();
  // Re-read cancellation after awaits rather than narrowing a mutable signal to false.
  const stopped = (): boolean => signal.aborted;

  while (!stopped() && Date.now() < deadline) {
    let clickedThisPass = false;
    for (const { title, button: name } of dialogs) {
      const btn = page
        .getByTestId('signing-modal')
        .filter({ has: page.getByRole('heading', { name: title, exact: true }) })
        .getByRole('button', { name, exact: true });
      const visible = await btn.isVisible({ timeout: 250 }).catch(() => false);
      if (!visible) {
        continue;
      }

      if (preClickDelayMs > 0) {
        console.log(`[signed] dialog "${name}" visible — pausing ${String(preClickDelayMs)}ms before click`);
        await page.waitForTimeout(preClickDelayMs);
      }
      if (stopped()) {
        return;
      }
      console.log(`[signed] dialog "${name}" — clicking`);
      await btn.click({ timeout: 2_000 });
      seen.add(`${title}: ${name}`);
      clickedThisPass = true;
      // Lets the modal close, or the next pass sees the same button.
      await page.waitForTimeout(500);
    }

    if (!clickedThisPass) {
      await page.waitForTimeout(500);
    }
  }

  if (stopped()) {
    return;
  }
  if (seen.size === 0) {
    console.log(`[signed] no host dialog appeared (looked for: ${dialogs.map(({ title }) => title).join(', ')})`);
  } else {
    console.log(`[signed] dialog budget exhausted after seeing: ${[...seen].join(', ')}`);
  }
}

async function waitForLogResult(
  entries: Locator,
  initialCount: number,
  testId: string,
  timeoutMs: number,
): Promise<'success' | 'error'> {
  try {
    await expect.poll(async () => entries.count(), { timeout: 10_000 }).toBeGreaterThan(initialCount);
  } catch {
    console.log(`[signed] ${testId}: no log entry within 10s`);
    return 'error';
  }

  const newest = entries.first();
  try {
    await expect(newest).not.toHaveAttribute('data-status', 'pending', {
      timeout: timeoutMs,
    });
  } catch {
    console.log(`[signed] ${testId}: stuck pending`);
    return 'error';
  }

  const status = await newest.getAttribute('data-status');
  if (status !== 'success') {
    const msg = await newest
      .locator('div.break-all')
      .textContent()
      .catch(() => '');
    console.log(`[signed] ${testId}: ${(msg ?? '').slice(0, 300)}`);
  }
  return status === 'success' ? 'success' : 'error';
}
