// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Waits on the page's own frame events, so a test never polls the frame tree on a timer.

import type { Frame, Page } from '@playwright/test';

/** Whether `url` is a product sandbox, which is served from its label's app subdomain. */
export function isSandboxUrl(url: string): boolean {
  return URL.canParse(url) && new URL(url).hostname.endsWith('.app.localhost');
}

/** The first frame whose URL matches, already there or the next one to navigate. */
export async function waitForFrame(page: Page, matches: (url: string) => boolean, timeout: number): Promise<Frame> {
  // Armed before the frame tree is read, so a frame that navigates in between is not missed.
  const navigated = page.waitForEvent('framenavigated', { predicate: frame => matches(frame.url()), timeout });
  const present = page.frames().find(frame => matches(frame.url()));
  if (present !== undefined) {
    navigated.catch(() => undefined);
    return present;
  }
  return navigated;
}

/** Waits until `frame` has written the product's page, which the sandbox marks with `dotli:app:end`. */
export async function waitForAppEnd(frame: Frame, timeout: number): Promise<void> {
  await frame.waitForFunction(
    () => performance.getEntriesByType('mark').some(mark => mark.name === 'dotli:app:end'),
    undefined,
    { timeout },
  );
}

/** The sandbox frame once it has written the product's page. */
export async function waitForRenderedSandbox(page: Page, timeout: number): Promise<Frame> {
  const frame = await waitForFrame(page, isSandboxUrl, timeout);
  await waitForAppEnd(frame, timeout);
  return frame;
}
