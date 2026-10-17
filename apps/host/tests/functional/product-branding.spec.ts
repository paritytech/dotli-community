// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The product's name and icon from its root manifest, shown in the browser tab once the product renders. Offline: a
// fake protocol frame publishes the manifest and serves the product's page and icon blocks.

import { expect } from '@playwright/test';
import type { RootManifest } from '@dotli/resolver';
import { PORT } from '../env.js';
import { seedBackend } from './fixtures/settings.js';
import { productPage, rawBlock } from './helpers/blocks.js';
import { fakeProtocol } from './helpers/fake-protocol.js';
import { waitForRenderedSandbox } from './helpers/frames.js';
import { test } from './helpers/shared-mode-reset.js';

const HOST_URL = `http://host-playground.localhost:${PORT}/`;

// A 1x1 PNG, so the tab has a real image to show.
const ICON_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

const DISPLAY_NAME = 'E2E Branded Product';

test('As a dApp user opening a product, I see its published name and icon in the browser tab', async ({ page }) => {
  // Given: a product whose root manifest names it and points at its icon
  const product = await rawBlock(productPage('branded'));
  const icon = await rawBlock(new Uint8Array(ICON_PNG));
  const root: RootManifest = {
    $v: 1,
    displayName: DISPLAY_NAME,
    description: 'Branded in the tab',
    icon: { cid: icon.cid, format: 'png' },
  };
  await seedBackend(page, 'smoldot-direct');
  await fakeProtocol(page, {
    resolve: { kind: 'cid', cid: product.cid },
    blocks: { [product.cid]: product.hex, [icon.cid]: icon.hex },
    rootManifest: { kind: 'ok', value: root, raw: JSON.stringify(root) },
  });

  // When
  await page.goto(HOST_URL);
  await waitForRenderedSandbox(page, 15_000);

  // Then
  await expect(page).toHaveTitle(DISPLAY_NAME, { timeout: 15_000 });
  const favicon = page.locator("link[rel='icon']");
  await expect(favicon).toHaveAttribute('href', /^blob:/, { timeout: 15_000 });
  await expect(favicon).toHaveAttribute('type', 'image/png');
  const href = await favicon.getAttribute('href');
  const shown = await page.evaluate(
    async url => Array.from(new Uint8Array(await (await fetch(url)).arrayBuffer())),
    href ?? '',
  );
  expect(Buffer.from(shown).equals(ICON_PNG)).toBe(true);
});
