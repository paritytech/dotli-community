// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The product frame over the real wallet core: what the user sees when the core under a product dies, and a preview
// of a web container app. Offline: a fake protocol frame serves the product's one block.

import { expect, type Page } from '@playwright/test';
import { PORT } from '../env.js';
import { seedBackend } from './fixtures/settings.js';
import { productPage, rawBlock } from './helpers/blocks.js';
import { PREVIEW_PRODUCT_ORIGIN, servePreviewProduct } from './helpers/fake-product.js';
import { fakeProtocol } from './helpers/fake-protocol.js';
import { isSandboxUrl, waitForRenderedSandbox } from './helpers/frames.js';
import { test } from './helpers/shared-mode-reset.js';
import { CORE_DEATH, CORE_WORKER, killCore, prependToWorker } from './helpers/worker-prelude.js';

const HOST_URL = `http://host-playground.localhost:${PORT}/`;

type ProductHarness = {
  /** Every sandbox document the product frame loaded, in order. */
  documents: string[];
  /** Every wallet core worker the page started, in order. */
  cores: string[];
};

/** Serves the product offline, lets the test take its core down, and records what the page loads for it. */
async function openProduct(page: Page): Promise<ProductHarness> {
  const block = await rawBlock(productPage('product'));
  await seedBackend(page, 'smoldot-direct');
  await fakeProtocol(page, { resolve: { kind: 'cid', cid: block.cid }, blocks: { [block.cid]: block.hex } });
  await prependToWorker(page.context(), CORE_WORKER, CORE_DEATH);
  // The status passes through `lost` within one task, and an observer reads the attribute only after it, so each
  // value is taken from the record of the change that replaced it.
  await page.addInitScript(() => {
    if (window.top !== window) {
      return;
    }
    const replaced: string[] = [];
    let target: HTMLElement | null = null;
    new MutationObserver(records => {
      for (const record of records) {
        target = record.target as HTMLElement;
        if (record.oldValue !== null) {
          replaced.push(record.oldValue);
        }
      }
    }).observe(document, { subtree: true, attributeFilter: ['data-product-frame'], attributeOldValue: true });
    Object.defineProperty(window, '__frameStatuses', {
      value: () => {
        const current = target?.dataset['productFrame'];
        return current === undefined ? [...replaced] : [...replaced, current];
      },
    });
  });
  const harness: ProductHarness = { documents: [], cores: [] };
  page.on('request', request => {
    if (request.resourceType() === 'document' && isSandboxUrl(request.url())) {
      harness.documents.push(request.url());
    }
  });
  page.on('worker', worker => {
    if (worker.url().includes('/assets/worker-runtime-')) {
      harness.cores.push(worker.url());
    }
  });
  await page.goto(HOST_URL);
  await waitForRenderedSandbox(page, 15_000);
  await expect(page.locator('[data-product-frame]')).toHaveAttribute('data-product-frame', 'connected');
  return harness;
}

function frameStatuses(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __frameStatuses: () => string[] }).__frameStatuses());
}

/** Waits until the frame has connected `times` times since the page loaded. */
async function connectedTimes(page: Page, times: number): Promise<void> {
  await page.waitForFunction(
    count =>
      (window as unknown as { __frameStatuses: () => string[] })
        .__frameStatuses()
        .filter(status => status === 'connected').length === count,
    times,
    { timeout: 15_000 },
  );
}

test('As a dApp user whose wallet core dies under my product, I see the product again on a new core', async ({
  page,
}) => {
  // Given
  const harness = await openProduct(page);

  // When
  await killCore(page);

  // Then
  await connectedTimes(page, 2);
  expect(await frameStatuses(page)).toEqual(['idle', 'connecting', 'connected', 'lost', 'connecting', 'connected']);
  expect(harness.documents).toHaveLength(2);
  expect(harness.cores).toHaveLength(2);
  await expect(page.getByTestId('notif-card').filter({ hasText: 'The app could not be reloaded.' })).toHaveCount(0);
});

test('As a dApp user whose wallet core keeps dying under my product, I see it shown again twice and then a reload offer', async ({
  page,
}) => {
  // Given
  const harness = await openProduct(page);

  // When: three quick deaths, each once the product is back on its new core
  await killCore(page);
  await connectedTimes(page, 2);
  await killCore(page);
  await connectedTimes(page, 3);
  await killCore(page);

  // Then
  await expect(page.locator('[data-product-frame]')).toHaveAttribute('data-product-frame', 'failed');
  const notice = page.getByTestId('notif-card').filter({ hasText: 'The app could not be reloaded.' });
  await expect(notice.getByTestId('notif-title')).toHaveText('dot.li');
  await expect(notice.getByTestId('notif-action')).toHaveText('Reload');
  expect(harness.documents).toHaveLength(3);
});

test('As a developer previewing a web container app, I see it in the product frame and the address bar keeps the preview route', async ({
  page,
}) => {
  // Given
  const target = `${PREVIEW_PRODUCT_ORIGIN}/deep?a=1`;
  const product = await servePreviewProduct(page, '/deep?a=1');

  // When
  await page.goto(product.shellUrl);

  // Then
  await expect(page.locator('[data-product-frame]')).toHaveAttribute('data-product-frame', 'connected', {
    timeout: 15_000,
  });
  expect(product.documents).toEqual([target]);
  const address = new URL(page.url());
  expect(address.pathname).toBe('/__preview');
  expect(address.searchParams.get('url')).toBe(target);
});
