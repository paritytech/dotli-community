// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Navigation is the same on every backend, so the suite runs offline: a fake protocol frame resolves the name and
// serves the product's one block through the host's relay, which `smoldot-direct` uses.

import { expect, type Page } from '@playwright/test';
import { getProductFrame, getProductLocation, waitForSandboxErrorPage } from '../productFrame.js';
import { test } from './helpers/sharedModeReset.js';
import { seedBackend } from './fixtures/settings.js';
import { productPage, rawBlock } from './helpers/blocks.js';
import { fakeProtocol } from './helpers/fakeProtocol.js';
import { PORT } from '../env.js';

const LABEL = 'host-playground';
const TIMEOUT_MS = parseInt(process.env['COMBO_TIMEOUT_MS'] ?? '45000', 10);

const HOST_BY_LABEL = `http://${LABEL}.localhost:${PORT}`;

/** Serves the product from one block with no network, for every load the page makes, reloads included. */
async function serveOffline(page: Page): Promise<void> {
  const block = await rawBlock(productPage('navigation'));
  await seedBackend(page, 'smoldot-direct');
  await fakeProtocol(page, { resolve: { kind: 'cid', cid: block.cid }, blocks: { [block.cid]: block.hex } });
}

test.describe('URL parameters are forwarded into the product', () => {
  test('As a visitor, I open http://<label>.dot.li/foo?a=b#h and land on /foo?a=b#h inside the product', async ({
    page,
  }) => {
    // Given
    await serveOffline(page);

    // When
    await page.goto(`${HOST_BY_LABEL}/foo?a=b#h`);

    // Then
    const product = await getProductFrame(page, TIMEOUT_MS);
    const loc = await getProductLocation(product);
    expect(loc.pathname).toBe('/foo');
    expect(loc.search).toBe('?a=b');
    expect(loc.hash).toBe('#h');
  });

  test('As a visitor, I open http://<label>.dot.li/?a=1&a=2 and both values reach the product', async ({ page }) => {
    // Given
    await serveOffline(page);

    // When
    await page.goto(`${HOST_BY_LABEL}/?a=1&a=2`);

    // Then
    const product = await getProductFrame(page, TIMEOUT_MS);
    const loc = await getProductLocation(product);
    expect(new URLSearchParams(loc.search).getAll('a')).toEqual(['1', '2']);
  });

  test('As a visitor, I open http://<label>.dot.li/?a= and the empty query value reaches the product', async ({
    page,
  }) => {
    // Given
    await serveOffline(page);

    // When
    await page.goto(`${HOST_BY_LABEL}/?a=`);

    // Then
    const product = await getProductFrame(page, TIMEOUT_MS);
    const loc = await getProductLocation(product);
    expect(loc.search).toBe('?a=');
  });
});

test.describe('Host URL bar preserves the entered URL after render', () => {
  // Canonicalisation re-inserts non-default settings on every load, so only the user's own params are asserted.
  test('As a visitor, I open http://<label>.dot.li/foo?a=b#h and the URL bar still shows /foo?a=b#h after the product renders', async ({
    page,
  }) => {
    // Given
    await serveOffline(page);

    // When
    await page.goto(`${HOST_BY_LABEL}/foo?a=b#h`);
    await getProductFrame(page, TIMEOUT_MS);

    // Then
    const url = new URL(page.url());
    expect(url.pathname).toBe('/foo');
    expect(url.searchParams.get('a')).toBe('b');
    expect(url.hash).toBe('#h');
  });
});

test.describe('Validator regression guards', () => {
  test('As a visitor, I reach a sandbox given an unknown chainBackend value and it renders an error page instead of guessing a default', async ({
    browser,
  }) => {
    // Given
    const context = await browser.newContext({
      serviceWorkers: 'allow',
    });
    // `route.continue({ url })` changes only the fetch URL, not the `window.location` the validator reads, so
    // rewrite history before the sandbox's own scripts run.
    await context.addInitScript(() => {
      if (!window.location.host.includes('.app.localhost')) {
        return;
      }
      const u = new URL(window.location.href);
      u.searchParams.set('chainBackend', 'bogus');
      history.replaceState(null, '', u.toString());
    });
    const page = await context.newPage();
    await serveOffline(page);

    try {
      // When
      await page.goto(`${HOST_BY_LABEL}/`);

      // Then
      const reason = await waitForSandboxErrorPage(page, TIMEOUT_MS);
      expect(reason).toContain('chainBackend');
      expect(reason).toContain('bogus');
    } finally {
      await context.close();
    }
  });
});
