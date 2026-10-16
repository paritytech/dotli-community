// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A preset move rebuilds the product's frame only when its `allow` attribute changes. Offline: a fake protocol frame
// serves the product.

import { expect } from '@playwright/test';
import { PORT } from '../env.js';
import { seedBackend } from './fixtures/settings.js';
import { productPage, rawBlock } from './helpers/blocks.js';
import { fakeProtocol } from './helpers/fake-protocol.js';
import { isSandboxUrl, waitForRenderedSandbox } from './helpers/frames.js';
import { test } from './helpers/shared-mode-reset.js';

const HOST_URL = `http://host-playground.localhost:${PORT}/`;

test('As a user moving from Secure to Restricted to Secure to Trusted, only Trusted reloads the app', async ({
  page,
}) => {
  // Given
  const product = await rawBlock(productPage('presets'));
  await seedBackend(page, 'smoldot-direct');
  await fakeProtocol(page, { resolve: { kind: 'cid', cid: product.cid }, blocks: { [product.cid]: product.hex } });
  await page.goto(HOST_URL);
  const first = await waitForRenderedSandbox(page, 15_000);
  await page.locator('#permissions-button').click();
  const presets = page.getByTestId('permissions-presets');
  const list = page.locator('#permissions-popover-list');
  await expect(presets).toHaveAttribute('data-preset', 'secure');
  let navigations = 0;
  page.on('framenavigated', frame => {
    if (isSandboxUrl(frame.url())) {
      navigations += 1;
    }
  });
  const settled = async (id: string): Promise<void> => {
    await expect(presets).toHaveAttribute('data-preset', id);
    await expect(list).not.toHaveAttribute('data-pending');
  };

  // When
  await page.getByTestId('permissions-preset-stop-restricted').click();
  await settled('restricted');
  await page.getByTestId('permissions-preset-stop-secure').click();
  await settled('secure');
  const reloaded = page.waitForEvent('framenavigated', {
    predicate: frame => isSandboxUrl(frame.url()),
    timeout: 15_000,
  });
  await page.getByTestId('permissions-preset-stop-trusted').click();
  await settled('trusted');
  await reloaded;

  // Then
  expect(navigations).toBe(1);
  expect(first.isDetached()).toBe(true);
});
