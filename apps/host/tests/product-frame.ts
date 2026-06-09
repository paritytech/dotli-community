// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Test helpers for probing the product Frame inside the sandbox iframe.
 *
 * The sandbox bootstrap calls `document.write` to swap the document with
 * the product HTML. Window/Frame identity is preserved across that swap,
 * so the same Frame returned by Playwright once `dotli:app:end` fires is
 * the product Frame we read `window.location` from.
 */

import { expect, type Frame, type Page } from "@playwright/test";
import { SANDBOX_CONTRACT_PARAMS } from "@dotli/config/host-sandbox-contract";

export interface ProductLocation {
  pathname: string;
  search: string;
  hash: string;
  href: string;
}

/**
 * Wait for the sandbox iframe to attach without requiring it to finish loading.
 * Returns null on timeout. Use this when the caller wants to handle a missing
 * frame itself (e.g. perf harness logs a warning and continues).
 */
export async function findAppFrame(
  page: Page,
  timeoutMs: number,
): Promise<Frame | null> {
  // `page.frames()` checks the live frame tree which catches an iframe
  // whose URL was set via `contentWindow.location` (not the DOM `src`
  // attribute). The locator-based wait misses that case. Bounded poll
  // with a short interval. Playwright's framework events fire between
  // iterations.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frame = page.frames().find((f) => f.url().includes(".app.localhost"));
    if (frame !== undefined) {
      return frame;
    }
    await page.waitForTimeout(200);
  }
  return null;
}

/**
 * Wait for the sandbox iframe to attach AND finish `document.write` so the
 * product's URL is the one the test should observe. Throws on timeout.
 */
export async function getProductFrame(
  page: Page,
  timeoutMs: number,
): Promise<Frame> {
  const start = Date.now();
  const frame = await findAppFrame(page, timeoutMs);
  if (frame === null) {
    throw new Error(
      `Sandbox iframe never appeared within ${String(timeoutMs)}ms`,
    );
  }
  const remaining = Math.max(1000, timeoutMs - (Date.now() - start));
  await frame.waitForFunction(
    () =>
      performance
        .getEntriesByType("mark")
        .some((m) => m.name === "dotli:app:end"),
    { timeout: remaining, polling: 500 },
  );
  return frame;
}

/** Read `window.location` from inside the product Frame in one round-trip. */
export async function getProductLocation(
  frame: Frame,
): Promise<ProductLocation> {
  return frame.evaluate(() => ({
    pathname: window.location.pathname,
    search: window.location.search,
    hash: window.location.hash,
    href: window.location.href,
  }));
}

/**
 * Assert that none of the host-to-sandbox contract keys leaked into the
 * product's `window.location.search`. Imports the contract names directly
 * so this can never drift from the source of truth.
 */
export function assertNoContractKeys(search: string): void {
  const params = new URLSearchParams(search);
  for (const key of Object.values(SANDBOX_CONTRACT_PARAMS)) {
    expect(
      params.has(key),
      `contract key "${key}" leaked into product location.search`,
    ).toBe(false);
  }
}

/** Wait for the host's error page; returns "title: detail" or "" on timeout. */
export async function waitForErrorPage(
  page: Page,
  timeoutMs: number,
): Promise<string> {
  try {
    await page
      .locator(".error-page-title")
      .first()
      .waitFor({ timeout: timeoutMs });
  } catch {
    return "";
  }
  const title =
    (await page
      .locator(".error-page-title")
      .first()
      .textContent()
      .catch(() => "")) ?? "";
  if (title.length === 0) {
    return "";
  }
  const detail =
    (await page
      .locator(".error-page-detail")
      .first()
      .textContent()
      .catch(() => "")) ?? "";
  return `${title}: ${detail}`;
}

/**
 * Wait for an error page rendered INSIDE the sandbox iframe (e.g. validator
 * failures from `validateSandboxParams`). The sandbox calls `showError(...)`
 * which writes `.error-page-title` / `.error-page-detail` into the sandbox
 * Frame's DOM. This never reaches the host page, and `dotli:app:end` never
 * fires on validation failure, so the regular helpers don't apply.
 *
 * Returns "title: detail" or "" on timeout.
 */
export async function waitForSandboxErrorPage(
  page: Page,
  timeoutMs: number,
): Promise<string> {
  const frame = await findAppFrame(page, timeoutMs);
  if (frame === null) {
    return "";
  }
  try {
    await frame
      .locator(".error-page-title")
      .first()
      .waitFor({ timeout: timeoutMs });
  } catch {
    return "";
  }
  const title =
    (await frame
      .locator(".error-page-title")
      .first()
      .textContent()
      .catch(() => "")) ?? "";
  if (title.length === 0) {
    return "";
  }
  const detail =
    (await frame
      .locator(".error-page-detail")
      .first()
      .textContent()
      .catch(() => "")) ?? "";
  return `${title}: ${detail}`;
}

/**
 * Race the shell's success path against the host error page. Throws when
 * the shell renders an error instead of completing, or when neither
 * outcome appears within `timeoutMs`. `label` is appended to the error
 * message so failing tests point at the right variant.
 */
export async function waitForResolutionOutcome(
  page: Page,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const successPromise = getProductFrame(page, timeoutMs).then(() => ({
    kind: "ok" as const,
  }));
  const errorPromise = waitForErrorPage(page, timeoutMs).then((reason) =>
    reason.length > 0
      ? { kind: "error" as const, reason }
      : { kind: "timeout" as const },
  );
  const result = await Promise.race([successPromise, errorPromise]);
  if (result.kind === "error") {
    throw new Error(`Shell rendered error page (${label}): ${result.reason}`);
  }
  if (result.kind === "timeout") {
    throw new Error(
      `Neither success nor error-page appeared within ${String(timeoutMs)}ms (${label})`,
    );
  }
}
