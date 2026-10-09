// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { DOMAIN, PORT, TIMEOUT_MS } from '../env.js';
import { getProductFrame } from '../product-frame.js';
import { setupTest } from './helpers/context.js';
import { test } from './helpers/shared-mode-reset.js';

const APP_URL = `http://${DOMAIN}.localhost:${PORT}/?debug=true`;
const LANDING_URL = `http://localhost:${PORT}/`;

// Substrate's public development phrase. It holds nothing and is safe to commit.
const DEV_PHRASE = 'bottom drive obey lake curtain smoke basket hold race lonely fit walk';

async function openWalletTab(page: Page): Promise<void> {
  await page.locator('[data-testid="td-section"][data-value="wallet"]').click();
  await expect(page.getByTestId('td-wallet')).toBeVisible();
}

test.setTimeout(TIMEOUT_MS * 4);

test('As a developer, I switch every app to a local wallet with my phrase and back again', async ({ browser }) => {
  // Given
  const { context, page } = await setupTest(browser, { backend: 'smoldot-shared-worker' });
  try {
    await page.goto(APP_URL);
    await openWalletTab(page);

    // When
    await page.getByTestId('td-wallet-phrase').fill(DEV_PHRASE);
    await Promise.all([page.waitForEvent('load'), page.getByTestId('td-wallet-use-local').click()]);

    // Then: connected without pairing with the product open, here and in another app on the domain, as a local account
    await expect(page.getByTestId('user-badge')).toHaveAttribute('data-wallet', 'local', { timeout: TIMEOUT_MS });
    await getProductFrame(page, TIMEOUT_MS);
    const landing = await context.newPage();
    await landing.goto(LANDING_URL);
    await expect(landing.getByTestId('user-badge')).toHaveAttribute('data-wallet', 'local', { timeout: TIMEOUT_MS });
    await openWalletTab(page);
    await expect(page.getByTestId('td-wallet-account')).toHaveText(/^0x[0-9a-f]{64}$/, { timeout: TIMEOUT_MS });

    // When
    await Promise.all([page.waitForEvent('load'), page.getByTestId('td-wallet-use-app').click()]);

    // Then: signed out here and in every other app
    await expect(page.getByRole('button', { name: 'Sign in with Polkadot Mobile' })).toBeVisible({
      timeout: TIMEOUT_MS,
    });
    await expect(page.getByTestId('user-badge')).toHaveCount(0);
    await landing.reload();
    await expect(landing.getByRole('button', { name: 'Sign in with Polkadot Mobile' })).toBeVisible({
      timeout: TIMEOUT_MS,
    });
    await expect(landing.getByTestId('user-badge')).toHaveCount(0);
  } finally {
    await context.close();
  }
});
