// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Navigation is the same on every backend, so the suite runs offline: a fake protocol frame resolves the name and
// serves the product's one block through the host's relay, which `smoldot-direct` uses.

import { expect, type Page } from '@playwright/test';
import {
  assertNoContractKeys,
  getProductFrame,
  getProductLocation,
  waitForSandboxErrorPage,
} from '../product-frame.js';
import { test } from './helpers/shared-mode-reset.js';
import { seedBackend } from './fixtures/settings.js';
import { productPage, rawBlock } from './helpers/blocks.js';
import { fakeProtocol } from './helpers/fake-protocol.js';
import { isSandboxUrl } from './helpers/frames.js';
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

  test('As a visitor, I open http://<label>.dot.li/foo%20bar and the percent-encoding survives into the product pathname', async ({
    page,
  }) => {
    // Given
    await serveOffline(page);

    // When
    await page.goto(`${HOST_BY_LABEL}/foo%20bar`);

    // Then
    const product = await getProductFrame(page, TIMEOUT_MS);
    const loc = await getProductLocation(product);
    expect(loc.pathname).toBe('/foo%20bar');
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

test.describe('Reloading the page preserves the URL', () => {
  test('As a visitor, I reload http://<label>.dot.li/foo?a=b and the path and query survive the reload', async ({
    page,
  }) => {
    // Given
    await serveOffline(page);
    await page.goto(`${HOST_BY_LABEL}/foo?a=b`);
    await getProductFrame(page, TIMEOUT_MS);

    // When
    await page.reload();

    // Then
    const product = await getProductFrame(page, TIMEOUT_MS);
    const loc = await getProductLocation(product);
    expect(loc.pathname).toBe('/foo');
    expect(loc.search).toBe('?a=b');
    expect(new URL(page.url()).pathname).toBe('/foo');
  });
});

test.describe('Sandbox URL hygiene: host contract keys never reach the product', () => {
  test("As a visitor, I load a product with a cold cache and the host contract keys are not visible in the product's URL", async ({
    page,
  }) => {
    // Given
    await serveOffline(page);

    // When
    await page.goto(`${HOST_BY_LABEL}/?a=b`);

    // Then
    const product = await getProductFrame(page, TIMEOUT_MS);
    const loc = await getProductLocation(product);
    expect(loc.search).toBe('?a=b');
    assertNoContractKeys(loc.search);
  });

  test("As a visitor, I load a product with a warm cache and the host contract keys are still not visible in the product's URL", async ({
    page,
  }) => {
    // Given: a first visit warms the CID cache
    await serveOffline(page);
    await page.goto(`${HOST_BY_LABEL}/?a=b`);
    await getProductFrame(page, TIMEOUT_MS);

    // When
    await page.goto(`${HOST_BY_LABEL}/?a=b`);

    // Then
    const product = await getProductFrame(page, TIMEOUT_MS);
    const loc = await getProductLocation(product);
    expect(loc.search).toBe('?a=b');
    assertNoContractKeys(loc.search);
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

  test('As a visitor, I open http://<label>.dot.li/?ref=42 and the unknown key reaches the product without tripping the validator', async ({
    page,
  }) => {
    // Given
    await serveOffline(page);

    // When
    await page.goto(`${HOST_BY_LABEL}/?ref=42`);

    // Then
    const product = await getProductFrame(page, TIMEOUT_MS);
    await expect(page.getByTestId('error-page-title')).toHaveCount(0);
    const loc = await getProductLocation(product);
    expect(new URLSearchParams(loc.search).get('ref')).toBe('42');
    assertNoContractKeys(loc.search);
  });

  test("As a visitor, I open http://<label>.dot.li/?chainBackend=foo and the host's valid value wins while mine is dropped from the product's URL", async ({
    page,
  }) => {
    // Given
    await serveOffline(page);

    // When
    await page.goto(`${HOST_BY_LABEL}/?chainBackend=foo`);

    // Then
    const product = await getProductFrame(page, TIMEOUT_MS);
    const loc = await getProductLocation(product);
    // Pinned so passing user contract keys through needs a deliberate change.
    expect(new URLSearchParams(loc.search).has('chainBackend')).toBe(false);
    assertNoContractKeys(loc.search);
  });
});

test.describe('Sandbox side-effects from URL contract keys', () => {
  // The sandbox frame is credentialless, so its storage goes with every page load whatever the URL says. What a link
  // can reach is the sandbox document's URL, which is what the sandbox reads `fullReset` from.
  test('As a visitor, I open http://<label>.dot.li/?fullReset=1 and the sandbox is not told to reset, since only the host resets it', async ({
    page,
  }) => {
    // Given
    await serveOffline(page);
    const sandboxDocuments: URL[] = [];
    page.on('request', request => {
      if (request.resourceType() === 'document' && isSandboxUrl(request.url())) {
        sandboxDocuments.push(new URL(request.url()));
      }
    });

    // When
    await page.goto(`${HOST_BY_LABEL}/?fullReset=1`);
    const product = await getProductFrame(page, TIMEOUT_MS);

    // Then
    expect(sandboxDocuments).not.toHaveLength(0);
    expect(sandboxDocuments.filter(url => url.searchParams.has('fullReset'))).toEqual([]);
    const loc = await getProductLocation(product);
    assertNoContractKeys(loc.search);
  });
});
