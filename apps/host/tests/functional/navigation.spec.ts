// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, type Page } from '@playwright/test';
import {
  assertNoContractKeys,
  getProductFrame,
  getProductLocation,
  waitForSandboxErrorPage,
} from '../product-frame.js';
import { test } from './helpers/shared-mode-reset.js';
import { seedBackend as seedChainBackend } from './fixtures/settings.js';
import { PORT } from '../env.js';

const LABEL = 'host-playground';
const TIMEOUT_MS = parseInt(process.env['COMBO_TIMEOUT_MS'] ?? '45000', 10);

const HOST_BY_LABEL = `http://${LABEL}.localhost:${PORT}`;

// Navigation is the same on every backend, so the suite pins the fastest and least flaky one.
async function seedBackend(page: Page): Promise<void> {
  await seedChainBackend(page, 'rpc-gateway');
}

const GATEWAY_FLAKY = 'flaky on CI: the product loads from the uncached IPFS gateway';

test.describe('URL parameters are forwarded into the product', () => {
  test('when I open http://<label>.dot.li/foo?a=b#h, I land on /foo?a=b#h inside the product', async ({ page }) => {
    // Given
    await seedBackend(page);

    // When
    await page.goto(`${HOST_BY_LABEL}/foo?a=b#h`);

    // Then
    const product = await getProductFrame(page, TIMEOUT_MS);
    const loc = await getProductLocation(product);
    expect(loc.pathname).toBe('/foo');
    expect(loc.search).toBe('?a=b');
    expect(loc.hash).toBe('#h');
  });

  test('when I open http://<label>.dot.li/foo%20bar, the percent-encoding survives into the product pathname', async ({
    page,
  }) => {
    // Given
    await seedBackend(page);

    // When
    await page.goto(`${HOST_BY_LABEL}/foo%20bar`);

    // Then
    const product = await getProductFrame(page, TIMEOUT_MS);
    const loc = await getProductLocation(product);
    expect(loc.pathname).toBe('/foo%20bar');
  });

  test('when I open http://<label>.dot.li/?a=1&a=2, both values reach the product', async ({ page }) => {
    // Given
    await seedBackend(page);

    // When
    await page.goto(`${HOST_BY_LABEL}/?a=1&a=2`);

    // Then
    const product = await getProductFrame(page, TIMEOUT_MS);
    const loc = await getProductLocation(product);
    expect(new URLSearchParams(loc.search).getAll('a')).toEqual(['1', '2']);
  });

  test('when I open http://<label>.dot.li/?a=, the empty query value reaches the product', async ({ page }) => {
    // Given
    await seedBackend(page);

    // When
    await page.goto(`${HOST_BY_LABEL}/?a=`);

    // Then
    const product = await getProductFrame(page, TIMEOUT_MS);
    const loc = await getProductLocation(product);
    expect(loc.search).toBe('?a=');
  });
});

test.describe('Host URL bar preserves the entered URL after render', () => {
  test.skip(true, GATEWAY_FLAKY);

  // Canonicalisation re-inserts non-default settings on every load, so only the user's own params are asserted.
  test('after the product renders from http://<label>.dot.li/foo?a=b#h, the URL bar still shows /foo?a=b#h', async ({
    page,
  }) => {
    // Given
    await seedBackend(page);

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
  test('when I reload http://<label>.dot.li/foo?a=b, the path and query survive the reload', async ({ page }) => {
    // Given
    await seedBackend(page);
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
  test("with a cold cache, when the product loads, the host contract keys are not visible in the product's URL", async ({
    page,
  }) => {
    // Given
    await seedBackend(page);

    // When
    await page.goto(`${HOST_BY_LABEL}/?a=b`);

    // Then
    const product = await getProductFrame(page, TIMEOUT_MS);
    const loc = await getProductLocation(product);
    expect(loc.search).toBe('?a=b');
    assertNoContractKeys(loc.search);
  });

  test("with a warm cache, when the product loads, the host contract keys are still not visible in the product's URL", async ({
    page,
  }) => {
    // Given
    await seedBackend(page);
    // Warms the CID cache.
    await page.goto(`${HOST_BY_LABEL}/?a=b`);
    await getProductFrame(page, TIMEOUT_MS);

    // When
    // Second visit takes the cache-hit code path in apps/host/src/main.ts.
    await page.goto(`${HOST_BY_LABEL}/?a=b`);

    // Then
    const product = await getProductFrame(page, TIMEOUT_MS);
    const loc = await getProductLocation(product);
    expect(loc.search).toBe('?a=b');
    assertNoContractKeys(loc.search);
  });
});

test.describe('Validator regression guards', () => {
  test('when the sandbox receives an unknown chainBackend value, the sandbox renders an error page instead of guessing a default', async ({
    browser,
  }) => {
    // Given
    const context = await browser.newContext({
      serviceWorkers: 'allow',
    });
    await context.addInitScript(() => {
      localStorage.setItem('dotli:chain-backend', 'rpc-gateway');
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

  test('when I open http://<label>.dot.li/?ref=42, the unknown key reaches the product and does not trigger the validator', async ({
    page,
  }) => {
    // Given
    await seedBackend(page);

    // When
    await page.goto(`${HOST_BY_LABEL}/?ref=42`);

    // Then
    const product = await getProductFrame(page, TIMEOUT_MS);
    const errorVisible = await page
      .getByTestId('error-page-title')
      .first()
      .isVisible()
      .catch(() => false);
    expect(errorVisible, 'unexpected error page for user query key').toBe(false);
    const loc = await getProductLocation(product);
    expect(new URLSearchParams(loc.search).get('ref')).toBe('42');
    assertNoContractKeys(loc.search);
  });

  test("when I open http://<label>.dot.li/?chainBackend=foo, the host's valid value wins and my value is dropped from the product's URL", async ({
    page,
  }) => {
    // Given
    await seedBackend(page);

    // When
    await page.goto(`${HOST_BY_LABEL}/?chainBackend=foo`);

    // Then
    const product = await getProductFrame(page, TIMEOUT_MS);
    const loc = await getProductLocation(product);
    // The host overwrites a user-supplied contract key, and the sandbox strips it. Pinned so passing user contract
    // keys through needs a deliberate change.
    expect(new URLSearchParams(loc.search).has('chainBackend')).toBe(false);
    assertNoContractKeys(loc.search);
  });
});

test.describe('Sandbox side-effects from URL contract keys', () => {
  test('when I open http://<label>.dot.li/?fullReset=1, sandbox-origin IndexedDB is purged before the product loads', async ({
    browser,
  }) => {
    // Given
    const context = await browser.newContext({
      serviceWorkers: 'allow',
    });
    await context.addInitScript(() => {
      localStorage.setItem('dotli:chain-backend', 'rpc-gateway');
    });
    const page = await context.newPage();

    try {
      // The second visit reuses this sandbox origin, so the marker persists until the purge wipes it.
      await page.goto(`${HOST_BY_LABEL}/`);
      let product = await getProductFrame(page, TIMEOUT_MS);

      const PURGE_MARKER_DB = '__nav-spec-fullreset-marker';
      await product.evaluate(async (dbName: string) => {
        await new Promise<void>((resolve, reject) => {
          const req = indexedDB.open(dbName, 1);
          req.onupgradeneeded = () => {
            req.result.createObjectStore('k');
          };
          req.onsuccess = () => {
            const tx = req.result.transaction('k', 'readwrite');
            tx.objectStore('k').put('alive', 'marker');
            tx.oncomplete = () => {
              req.result.close();
              resolve();
            };
            tx.onerror = () => {
              reject(tx.error ?? new Error('marker write failed'));
            };
          };
          req.onerror = () => {
            reject(req.error ?? new Error('marker db open failed'));
          };
        });
      }, PURGE_MARKER_DB);

      // When
      // Visit 2: user-supplied `?fullReset=1` flows from getDeepPath into the
      // iframe URL, the validator accepts it, then purgeSandboxOriginState
      // fires. This is the documented footgun: anyone can wipe a visitor's
      // sandbox-origin state by linking `acme.dot.li?fullReset=1`.
      await page.goto(`${HOST_BY_LABEL}/?fullReset=1`);
      product = await getProductFrame(page, TIMEOUT_MS);

      // Then
      const dbNames = await product.evaluate(async () => {
        const dbs = await indexedDB.databases();
        return dbs.map(d => d.name).filter((n): n is string => typeof n === 'string');
      });
      expect(dbNames).not.toContain(PURGE_MARKER_DB);
      const loc = await getProductLocation(product);
      assertNoContractKeys(loc.search);
    } finally {
      await context.close();
    }
  });
});
