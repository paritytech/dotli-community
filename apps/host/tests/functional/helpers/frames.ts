// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Waits on the page's own frame events, so a test never polls the frame tree on a timer.

import type { Frame, Page } from '@playwright/test';
import { PORT } from '../../env.js';

/** The root origin every page's protocol frame and sign-in window load from. */
export const ROOT_ORIGIN = `http://localhost:${PORT}`;

/** Whether `url` is the protocol frame, which every page loads from the root origin's `/__protocol/`. */
export function isProtocolFrameUrl(url: string): boolean {
  if (!URL.canParse(url)) {
    return false;
  }
  const parsed = new URL(url);
  return parsed.origin === ROOT_ORIGIN && parsed.pathname.startsWith('/__protocol/');
}

/** Whether `url` is a product sandbox, which is served from its label's app subdomain. */
export function isSandboxUrl(url: string): boolean {
  return URL.canParse(url) && new URL(url).hostname.endsWith('.app.localhost');
}

/** The first frame whose URL matches, already there or the next one to navigate. */
export function waitForFrame(page: Page, matches: (url: string) => boolean, timeout: number): Promise<Frame> {
  const present = page.frames().find(frame => matches(frame.url()));
  if (present !== undefined) {
    return Promise.resolve(present);
  }
  // `framenavigated` also reports an iframe navigated through `contentWindow.location`, which a locator misses.
  return page.waitForEvent('framenavigated', { predicate: frame => matches(frame.url()), timeout });
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
