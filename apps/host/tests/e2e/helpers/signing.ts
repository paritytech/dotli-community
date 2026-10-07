// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, type Page, type Frame, type Locator } from '@playwright/test';

type PageLike = Page | Frame;

/** The signing-host CLI signs once the SignRequest reaches the Statement Store, so only host dialogs need clicks. */
export async function runWebSignedTest(
  hostPage: Page,
  productFrame: PageLike,
  testId: string,
  dialogButtons: readonly string[],
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
    dialogButtons.length > 0
      ? clickHostDialogs(hostPage, dialogButtons, 60_000, preClickDelayMs, dialogController.signal).catch(() => {})
      : Promise.resolve();

  const result = await waitForLogResult(entries, initialCount, testId, timeoutMs);
  dialogController.abort();
  await dialogTask;
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

/** Clicks whichever of `buttonNames` shows until none has for a while, so callers need not know the dialog order. */
async function clickHostDialogs(
  page: Page,
  buttonNames: readonly string[],
  timeoutMs: number,
  preClickDelayMs: number,
  signal: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const idleStopMs = 5_000;
  let lastSeenAt = Date.now();
  const seen = new Set<string>();

  while (!signal.aborted && Date.now() < deadline) {
    if (Date.now() - lastSeenAt > idleStopMs && seen.size > 0) {
      return;
    }

    let clickedThisPass = false;
    for (const name of buttonNames) {
      const btn = page.getByRole('button', { name, exact: true }).first();
      const visible = await btn.isVisible({ timeout: 250 }).catch(() => false);
      if (!visible) {
        continue;
      }

      if (preClickDelayMs > 0) {
        console.log(`[signed] dialog "${name}" visible — pausing ${String(preClickDelayMs)}ms before click`);
        await page.waitForTimeout(preClickDelayMs);
      }
      // The fixture's auto-allow poller can close this modal during the pause, and an unbounded click would then
      // never reach the next dialog.
      console.log(`[signed] dialog "${name}" — clicking`);
      await btn.click({ timeout: 2_000 }).catch((e: unknown) => {
        const reason = e instanceof Error ? e.message : String(e);
        console.log(`[signed] dialog "${name}" click skipped: ${reason}`);
      });
      seen.add(name);
      lastSeenAt = Date.now();
      clickedThisPass = true;
      // Lets the modal close, or the next pass sees the same button.
      await page.waitForTimeout(500);
    }

    if (!clickedThisPass) {
      await page.waitForTimeout(500);
    }
  }

  if (signal.aborted) {
    return;
  }
  if (seen.size === 0) {
    console.log(`[signed] no host dialog appeared (looked for: ${buttonNames.join(', ')})`);
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
