// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Drives the sign-in window, which a product signs in and out through, and serves the fixture pages that open it where
// a dotli page cannot: an opener page that runs the pages' own handoff, and a third-party site, by popup or by redirect.

import { resolve } from 'node:path';
import { expect, type Locator, type Page } from '@playwright/test';
import { NETWORK, TIMEOUT_MS } from '../../env.js';
import { ROOT_ORIGIN } from './frames.js';
import { SESSION_OPENER_BUNDLE_PATH, SITE_OPENER_BUNDLE_PATH, SITE_REDIRECT_BUNDLE_PATH } from './wire-bundles.js';

// Substrate's public development phrase. It holds nothing and is safe to commit.
export const DEV_PHRASE = 'bottom drive obey lake curtain smoke basket hold race lonely fit walk';

const OPENER_PAGE = resolve(import.meta.dirname, '../fixtures/session-opener.html');
const OPENER_PATH = '/__dotli-e2e/session-opener.html';
const OPENER_SCRIPT_PATH = '/__dotli-e2e/session-opener.js';

/** A third-party site on https, off the window's root domain. */
export const SITE_ORIGIN = 'https://site.example';
const SITE_PAGE = resolve(import.meta.dirname, '../fixtures/site-opener.html');
const SITE_SCRIPT_PATH = '/site-opener.js';
const REDIRECT_PAGE = resolve(import.meta.dirname, '../fixtures/site-redirect.html');
const REDIRECT_SCRIPT_PATH = '/site-redirect.js';
const WELL_KNOWN_PATH = '/.well-known/polkadot-signin.json';
/** The address the redirect fixture comes back to with the window's answer. */
export const SITE_RETURN_URL = `${SITE_ORIGIN}/back`;

/** The window's content, whose `data-view` says which view it shows. */
export function sessionWindow(window: Page): Locator {
  return window.getByTestId('session-window');
}

/** Waits for the window `click` opens, which the click opens in the turn of the user's gesture. */
export async function openSessionWindow(page: Page, click: () => Promise<unknown>): Promise<Page> {
  const [window] = await Promise.all([page.waitForEvent('popup'), click()]);
  return window;
}

/** Settles once `window` has closed, at once when it already has. */
export async function untilClosed(window: Page): Promise<void> {
  if (!window.isClosed()) {
    await window.waitForEvent('close', { timeout: TIMEOUT_MS });
  }
}

/** Opens the debug panel's wallet tab, on a page loaded with `?debug=true` so its panel shows. */
export async function openWalletTab(page: Page): Promise<void> {
  await page.locator('[data-testid="td-section"][data-value="wallet"]').click();
  await expect(page.getByTestId('td-wallet')).toBeVisible({ timeout: TIMEOUT_MS });
}

/**
 * Opens the sign-in window at its recovery phrase view from the debug panel's wallet tab, which asks for the phrase in
 * the window's request. `page` was loaded with `?debug=true`, so its panel shows.
 */
export async function openPhraseWindow(page: Page): Promise<Page> {
  await openWalletTab(page);
  const window = await openSessionWindow(page, () => page.getByTestId('td-wallet-import').click());
  // The window reads its request and takes it out of the fragment.
  await expect.poll(() => new URL(window.url()).pathname, { timeout: TIMEOUT_MS }).toBe('/s/auth');
  await expect.poll(() => new URL(window.url()).hash, { timeout: TIMEOUT_MS }).toBe('');
  return window;
}

/** Imports the development phrase on the window's recovery phrase view and waits for it to close itself. */
export async function submitPhraseInWindow(window: Page): Promise<void> {
  await expect(sessionWindow(window)).toHaveAttribute('data-view', 'phrase', { timeout: TIMEOUT_MS });
  await window.getByTestId('session-window-phrase-input').fill(DEV_PHRASE);
  await Promise.all([
    window.waitForEvent('close', { timeout: TIMEOUT_MS }),
    window.getByTestId('session-window-phrase-submit').click(),
  ]);
}

/**
 * Serves the opener fixture page on `origin`, any origin the test picks, and returns its URL. The page opens the
 * window from its button and marks the round's outcome on its output.
 */
export async function serveSessionOpener(page: Page, origin: string): Promise<string> {
  await page.route(`${origin}/__dotli-e2e/**`, async route => {
    const { pathname } = new URL(route.request().url());
    if (pathname === OPENER_PATH) {
      await route.fulfill({ path: OPENER_PAGE, contentType: 'text/html' });
    } else if (pathname === OPENER_SCRIPT_PATH) {
      await route.fulfill({ path: SESSION_OPENER_BUNDLE_PATH, contentType: 'text/javascript' });
    } else {
      await route.fulfill({ status: 404 });
    }
  });
  return `${origin}${OPENER_PATH}?net=${NETWORK}`;
}

/**
 * The opener fixture's output, whose `data-outcome` is the round's outcome once it ends, and `data-reply` the keys of
 * the window's last reply.
 */
export function openerOutcome(page: Page): Locator {
  return page.getByTestId('opener-outcome');
}

/**
 * Serves the site fixture page at the root of `origin`, a third-party https origin unless the test picks another, and
 * returns its URL, which names the window's origin and the `route` it opens. `account: 'none'` makes the page leave the
 * account out of a transaction request. The page opens the window from its button as a site does and marks the window's last
 * reply on its output.
 */
export async function serveSiteOpener(
  page: Page,
  {
    origin = SITE_ORIGIN,
    route: windowRoute = 'auth',
    account,
  }: { origin?: string; route?: 'auth' | 'sign'; account?: 'none' } = {},
): Promise<string> {
  await page.route(`${origin}/**`, async route => {
    const { pathname } = new URL(route.request().url());
    if (pathname === '/') {
      await route.fulfill({ path: SITE_PAGE, contentType: 'text/html' });
    } else if (pathname === SITE_SCRIPT_PATH) {
      await route.fulfill({ path: SITE_OPENER_BUNDLE_PATH, contentType: 'text/javascript' });
    } else {
      await route.fulfill({ status: 404 });
    }
  });
  const query = new URLSearchParams({ window: ROOT_ORIGIN, net: NETWORK, route: windowRoute });
  if (account !== undefined) {
    query.set('account', account);
  }
  return `${origin}/?${query.toString()}`;
}

/**
 * Serves the redirect fixture page at the root of the third-party site and at its return address, with the site's
 * well-known file, which lists the return address unless `listed` is false, and returns the page's URL. The page goes
 * to the sign-in window by redirect from its button, and back on the return address marks the window's sealed answer
 * on its output.
 */
export async function serveSiteRedirect(page: Page, { listed = true }: { listed?: boolean } = {}): Promise<string> {
  await page.route(`${SITE_ORIGIN}/**`, async route => {
    const { pathname } = new URL(route.request().url());
    if (pathname === '/' || pathname === new URL(SITE_RETURN_URL).pathname) {
      await route.fulfill({ path: REDIRECT_PAGE, contentType: 'text/html' });
    } else if (pathname === REDIRECT_SCRIPT_PATH) {
      await route.fulfill({ path: SITE_REDIRECT_BUNDLE_PATH, contentType: 'text/javascript' });
    } else if (pathname === WELL_KNOWN_PATH) {
      // The window reads the file from its own origin, so the site allows the read.
      await route.fulfill({
        json: { return_to: [listed ? SITE_RETURN_URL : `${SITE_ORIGIN}/elsewhere`] },
        headers: { 'Access-Control-Allow-Origin': '*' },
      });
    } else {
      await route.fulfill({ status: 404 });
    }
  });
  const query = new URLSearchParams({ window: ROOT_ORIGIN, net: NETWORK });
  return `${SITE_ORIGIN}/?${query.toString()}`;
}

/**
 * The site fixture's output, whose `data-type` and `data-reason` are those of the window's last reply, and whose
 * `data-result` is the reply's result as JSON for a result.
 */
export function siteReply(page: Page): Locator {
  return page.getByTestId('site-reply');
}
