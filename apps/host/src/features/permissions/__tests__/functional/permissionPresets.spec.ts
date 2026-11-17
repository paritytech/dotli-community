// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A preset move rebuilds the product's frame only when its `allow` attribute changes, as when a device is blocked.
// Offline: a fake protocol frame serves the product.

import { expect } from '@playwright/test';
import { PORT } from '../../../../../tests/env.js';
import { seedBackend } from '../../../../../tests/functional/fixtures/settings.js';
import { productPage, rawBlock } from '../../../../../tests/functional/helpers/blocks.js';
import { fakeProtocol } from '../../../../../tests/functional/helpers/fakeProtocol.js';
import { isSandboxUrl, waitForRenderedSandbox } from '../../../../../tests/functional/helpers/frames.js';
import { test } from '../../../../../tests/functional/helpers/sharedModeReset.js';

const HOST_URL = `http://host-playground.localhost:${PORT}/`;

test('As a user moving from Secure to Trusted to Restricted, only Restricted reloads the app', async ({ page }) => {
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

  const settledNavigations: number[] = [];

  // When
  await page.getByTestId('permissions-preset-stop-trusted').click();
  await settled('trusted');
  settledNavigations.push(navigations);
  const reloaded = page.waitForEvent('framenavigated', {
    predicate: frame => isSandboxUrl(frame.url()),
    timeout: 15_000,
  });
  await page.getByTestId('permissions-preset-stop-restricted').click();
  await settled('restricted');
  await reloaded;
  settledNavigations.push(navigations);

  // Then
  expect(settledNavigations).toEqual([0, 1]);
  expect(first.isDetached()).toBe(true);
});
