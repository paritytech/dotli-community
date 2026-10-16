// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The sandbox swaps in the product HTML with `document.write`, which keeps the Frame, so the sandbox Frame is the
// product Frame once `dotli:app:end` fires.

import { expect, type Frame, type Page } from '@playwright/test';
// From its source file: the `@dotli/config` barrel reads `self.location` and `import.meta.env` at load, so Node
// cannot load it.
import { SANDBOX_CONTRACT_PARAMS } from '../../../packages/config/src/host-sandbox-contract.js';

export interface ProductLocation {
  pathname: string;
  search: string;
  hash: string;
  href: string;
}

/** Does not wait for the frame to finish loading. */
export async function findAppFrame(page: Page, timeoutMs: number): Promise<Frame | null> {
  // The live frame tree catches an iframe navigated through `contentWindow.location`, which a locator misses.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frame = page.frames().find(f => f.url().includes('.app.localhost'));
    if (frame !== undefined) {
      return frame;
    }
    await page.waitForTimeout(200);
  }
  return null;
}

/** Throws at once on the sandbox's error page, since a failed fetch never sets `dotli:app:end`. */
export async function getProductFrame(page: Page, timeoutMs: number): Promise<Frame> {
  const start = Date.now();
  const frame = await findAppFrame(page, timeoutMs);
  if (frame === null) {
    throw new Error(`Sandbox iframe never appeared within ${String(timeoutMs)}ms`);
  }
  const remaining = Math.max(1000, timeoutMs - (Date.now() - start));
  const rendered = frame
    .waitForFunction(() => performance.getEntriesByType('mark').some(m => m.name === 'dotli:app:end'), {
      timeout: remaining,
      polling: 500,
    })
    .then(() => ({ kind: 'ok' as const }));
  // Never settles without an error page, so its own timeout cannot win the race with a misleading error.
  const failed = frame
    .getByTestId('error-page-title')
    .first()
    .waitFor({ timeout: remaining })
    .then(async () => ({
      kind: 'error' as const,
      reason: await readErrorText(frame),
    }))
    .catch(() => new Promise<never>(() => undefined));
  // A sandbox frame that stopped answering holds `waitForFunction` past its own timeout.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<{ kind: 'timeout' }>(resolve => {
    timer = setTimeout(() => {
      resolve({ kind: 'timeout' });
    }, remaining + 1000);
  });
  try {
    const result = await Promise.race([rendered, failed, deadline]);
    if (result.kind === 'error') {
      throw new Error(`Sandbox rendered error page: ${result.reason}`);
    }
    if (result.kind === 'timeout') {
      throw new Error(`Product never rendered within ${String(timeoutMs)}ms (no dotli:app:end mark)`);
    }
    return frame;
  } finally {
    clearTimeout(timer);
  }
}

/** Read `window.location` from inside the product Frame in one round-trip. */
export async function getProductLocation(frame: Frame): Promise<ProductLocation> {
  return frame.evaluate(() => ({
    pathname: window.location.pathname,
    search: window.location.search,
    hash: window.location.hash,
    href: window.location.href,
  }));
}

export function assertNoContractKeys(search: string): void {
  const params = new URLSearchParams(search);
  for (const key of Object.values(SANDBOX_CONTRACT_PARAMS)) {
    expect(params.has(key), `contract key "${key}" leaked into product location.search`).toBe(false);
  }
}

/** "title: detail", or "" when the page has no error title. */
async function readErrorText(scope: Page | Frame): Promise<string> {
  const title =
    (await scope
      .getByTestId('error-page-title')
      .first()
      .textContent()
      .catch(() => '')) ?? '';
  if (title.length === 0) {
    return '';
  }
  const detail =
    (await scope
      .getByTestId('error-page-detail')
      .first()
      .textContent()
      .catch(() => '')) ?? '';
  return `${title}: ${detail}`;
}

/** "" on timeout. */
export async function waitForErrorPage(page: Page, timeoutMs: number): Promise<string> {
  try {
    await page.getByTestId('error-page-title').first().waitFor({ timeout: timeoutMs });
  } catch {
    return '';
  }
  return readErrorText(page);
}

/** An error page inside the sandbox frame never reaches the host page or sets `dotli:app:end`. "" on timeout. */
export async function waitForSandboxErrorPage(page: Page, timeoutMs: number): Promise<string> {
  const frame = await findAppFrame(page, timeoutMs);
  if (frame === null) {
    return '';
  }
  try {
    await frame.getByTestId('error-page-title').first().waitFor({ timeout: timeoutMs });
  } catch {
    return '';
  }
  return readErrorText(frame);
}

/** `label` names the failing variant in the thrown message. */
export async function waitForResolutionOutcome(page: Page, timeoutMs: number, label: string): Promise<void> {
  const successPromise = getProductFrame(page, timeoutMs).then(() => ({
    kind: 'ok' as const,
  }));
  const errorPromise = waitForErrorPage(page, timeoutMs).then(reason =>
    reason.length > 0 ? { kind: 'error' as const, reason } : { kind: 'timeout' as const },
  );
  const result = await Promise.race([successPromise, errorPromise]);
  if (result.kind === 'error') {
    throw new Error(`Shell rendered error page (${label}): ${result.reason}`);
  }
  if (result.kind === 'timeout') {
    throw new Error(`Neither success nor error-page appeared within ${String(timeoutMs)}ms (${label})`);
  }
}
