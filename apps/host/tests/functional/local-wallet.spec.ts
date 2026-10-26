// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { expect } from '@playwright/test';
import { DOMAIN, PORT, TIMEOUT_MS } from '../env.js';
import { getProductFrame } from '../product-frame.js';
import { setupTest } from './helpers/context.js';
import { openPhraseWindow, openWalletTab, submitPhraseInWindow, untilClosed } from './helpers/session-window.js';
import { readSessionFlag, setSessionFlag, test } from './helpers/shared-mode-reset.js';

const APP_URL = `http://${DOMAIN}.localhost:${PORT}/?debug=true`;
const LANDING_URL = `http://localhost:${PORT}/`;

test.setTimeout(TIMEOUT_MS * 4);

test('As a developer, I switch every app to a local wallet through the sign-in window and back', async ({
  browser,
  request,
}) => {
  // Given a product page on the shared-worker backend
  const { context, page } = await setupTest(browser, { backend: 'smoldot-shared-worker' });
  try {
    await page.goto(APP_URL);

    // When: the phrase is typed in the window, which sends the wallet back and closes, and the page boots on it
    const window = await openPhraseWindow(page);
    await Promise.all([page.waitForEvent('load'), submitPhraseInWindow(window)]);

    // Then: connected without pairing with the product open, here and in another app on the domain, as a local account
    await expect(page.getByTestId('user-badge')).toHaveAttribute('data-wallet', 'local', { timeout: TIMEOUT_MS });
    await getProductFrame(page, TIMEOUT_MS);
    const landing = await context.newPage();
    await landing.goto(LANDING_URL);
    await expect(landing.getByTestId('user-badge')).toHaveAttribute('data-wallet', 'local', { timeout: TIMEOUT_MS });
    await openWalletTab(page);
    await expect(page.getByTestId('td-wallet-account')).toHaveText(/^0x[0-9a-f]{64}$/, { timeout: TIMEOUT_MS });

    // When: going back to Polkadot App signs out, through the sign-out window, and the page boots again
    const [signOut] = await Promise.all([
      page.waitForEvent('popup'),
      page.waitForEvent('load'),
      page.getByTestId('td-wallet-forget').click(),
    ]);

    // Then: signed out here and in every other app, and the window closed itself
    await untilClosed(signOut);
    await expect(page.getByRole('button', { name: 'Sign in with Polkadot App' })).toBeVisible({
      timeout: TIMEOUT_MS,
    });
    await expect(page.getByTestId('user-badge')).toHaveCount(0);
    expect(await readSessionFlag(request)).toBe(false);
    // With the flag back, a page shows only what the main store still holds, which is nothing. A product offers to
    // continue the sign-in the flag claims, while the landing page, which reads the main store itself, offers a plain
    // sign-in.
    await setSessionFlag(request);
    await Promise.all([page.reload(), landing.reload()]);
    await expect(page.getByRole('button', { name: 'Continue session' })).toBeVisible({
      timeout: TIMEOUT_MS,
    });
    await expect(page.getByTestId('user-badge')).toHaveCount(0);
    await expect(landing.getByRole('button', { name: 'Sign in with Polkadot App' })).toBeVisible({
      timeout: TIMEOUT_MS,
    });
    await expect(landing.getByTestId('user-badge')).toHaveCount(0);
  } finally {
    await context.close();
  }
});
