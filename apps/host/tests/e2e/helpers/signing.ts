// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, type Page, type Frame, type Locator } from '@playwright/test';
import { entryText } from './run-test.js';

type PageLike = Page | Frame;

/** The title of a host dialog, as the host draws it. */
export type HostDialogTitle =
  | 'Account Access'
  | 'Identity Disclosure'
  | 'Permission Request'
  | 'Product Account'
  | 'Resource Allocation'
  | 'Sign Message'
  | 'Sign Transaction'
  | 'Submit Preimage';

/** The button that answers a host dialog. */
export type HostAnswer = 'Always allow' | 'Allow' | 'Allow once' | 'Sign';

/** A dialog the host is expected to show, and the button that answers it. */
export interface HostDialog {
  title: HostDialogTitle;
  answer: HostAnswer;
}

/**
 * Answers each expected dialog in order, failing when one never shows. The button is looked up inside the dialog with
 * that title, so another dialog with the same button does not stand in for it. Each answer waits for its own dialog to
 * close, found by the title id the host gives every dialog, so two dialogs in a row with the same title stay apart.
 */
export async function answerHostDialogs(page: Page, dialogs: readonly HostDialog[], timeoutMs = 60_000): Promise<void> {
  for (const { title, answer } of dialogs) {
    const dialog = page.getByRole('dialog', { name: title, exact: true });
    const button = dialog.getByRole('button', { name: answer, exact: true });
    await expect(button, `the host asked "${title}", answered by "${answer}"`).toBeVisible({ timeout: timeoutMs });
    const titleId = await dialog.getAttribute('aria-labelledby');
    if (titleId === null) {
      throw new Error(`the "${title}" dialog has no title id`);
    }
    await button.click();
    await expect(page.locator(`[data-testid="host-prompt-backdrop"][aria-labelledby="${titleId}"]`)).toHaveCount(0);
  }
}

/**
 * Answers the dialog the core opens before it first shares the product's account. The product's own account asks
 * "Product Account", and another product's asks "Account Access", whose lasting grant keeps later reads quiet.
 */
export async function answerAccountDialog(page: Page, timeoutMs: number): Promise<void> {
  const ownAccount = page.getByRole('dialog', { name: 'Product Account', exact: true });
  const otherAccount = page.getByRole('dialog', { name: 'Account Access', exact: true });
  await expect(ownAccount.or(otherAccount), 'the host asked to share the product account').toBeVisible({
    timeout: timeoutMs,
  });
  const dialog: HostDialog =
    (await ownAccount.count()) > 0
      ? { title: 'Product Account', answer: 'Allow' }
      : { title: 'Account Access', answer: 'Always allow' };
  await answerHostDialogs(page, [dialog], timeoutMs);
}

/** The signing-host CLI signs once the SignRequest reaches the Statement Store, so only host dialogs need clicks. */
export async function runWebSignedTest(
  hostPage: Page,
  productFrame: PageLike,
  testId: string,
  dialogs: readonly HostDialog[],
  opts: { timeoutMs?: number } = {},
): Promise<'success' | 'error'> {
  const timeoutMs = opts.timeoutMs ?? 90_000;
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

  await answerHostDialogs(hostPage, dialogs);

  return waitForLogResult(entries, initialCount, testId, timeoutMs);
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
    console.log(`[signed] ${testId}: ${await entryText(newest)}`);
  }
  return status === 'success' ? 'success' : 'error';
}
