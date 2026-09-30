// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Smoke checks for the shell UI that the Solid migration rewrites piece by
// piece. None of these wait for a chain: they stop at what the shell renders
// by itself. End-to-end resolution lives in resolution.spec.ts.

import { expect } from '@playwright/test';
import { PORT } from '../env.js';
import { test } from './helpers/shared-mode-reset.js';

const LANDING_URL = `http://localhost:${PORT}/`;
const LABEL_URL = `http://browse.localhost:${PORT}/`;
// Same endpoint shared-mode-reset uses; 127.0.0.1 because Node on Linux does
// not resolve *.localhost.
const SHARED_STORE = `http://127.0.0.1:${PORT}/__dotli-mode/`;

test.describe('Shell UI smoke', () => {
  test('As a returning user, the landing page shows my recent sites as pills', async ({ page, request }) => {
    // Given
    const put = await request.put(`${SHARED_STORE}dotli_recent`, {
      data: JSON.stringify(['browse', 'playground']),
    });
    expect(put.ok()).toBe(true);

    // When
    await page.goto(LANDING_URL);

    // Then
    await expect(page.locator('#dotli-nav-form')).toBeVisible();
    const pills = page.locator('#dotli-recent .landing-recent-pill');
    await expect(pills).toHaveCount(2);
    await expect(pills.first()).toHaveAttribute('href', /browse/);
  });

  test('As a user, submitting a name on the landing page takes me to that site', async ({ page }) => {
    // Given
    await page.goto(LANDING_URL);

    // When
    await page.locator('#dotli-nav-input').fill('browse');
    await page.locator('#dotli-nav-input').press('Enter');

    // Then
    await expect(page).toHaveURL(/\/\/browse\./);
  });

  test("As a user, the shell's islands hydrate without errors, and its login button opens the QR modal", async ({
    page,
  }) => {
    // Given
    const problems: string[] = [];
    page.on('console', message => {
      if (message.type() === 'error' || message.type() === 'warning') {
        problems.push(message.text());
      }
    });
    page.on('pageerror', err => {
      problems.push(err.message);
    });

    // When
    await page.goto(LANDING_URL);

    // Then: the landing page renders its own theme button, and the topbar's
    // action group, More button included, is gone.
    await expect(page.locator('#landing-theme-toggle')).toHaveAttribute('title', /^Theme: /);
    await expect(page.locator('#theme-toggle')).toHaveCount(0);
    await expect(page.locator('#more-button')).toHaveCount(0);
    expect(problems.filter(text => /solid|island|hydrat/i.test(text))).toEqual([]);

    // When
    await page.locator('#landing-auth-button').click();

    // Then
    await expect(page.locator('#auth-modal-backdrop')).toHaveClass(/\bopen\b/);
    await expect(page.locator('#auth-modal-title')).toBeVisible();
  });

  test('As a phone user, the topbar keeps the account button and folds the rest into the More menu', async ({
    page,
  }) => {
    // Given
    await page.setViewportSize({ width: 375, height: 740 });

    // When
    await page.goto(LABEL_URL);
    await expect(page.locator('#topbar-actions[data-collapsible]')).toBeAttached();

    // Then
    await expect(page.locator('#auth-button')).toBeVisible();
    await expect(page.locator('#more-button')).toBeVisible();
    await expect(page.locator('#mode-button')).toBeHidden();

    // When
    await page.locator('#more-button').click();
    await page.locator('#more-popover .more-row[data-item="settings"]').click();

    // Then
    await expect(page.locator('#more-popover')).not.toHaveClass(/\bopen\b/);
    await expect(page.locator('#mode-popover')).toHaveClass(/\bopen\b/);
  });

  test('As a desktop user, every topbar button fits and there is no More button', async ({ page }) => {
    // Given
    await page.setViewportSize({ width: 1280, height: 800 });

    // When
    await page.goto(LABEL_URL);
    await expect(page.locator('#topbar-actions[data-collapsible]')).toBeAttached();

    // Then
    await expect(page.locator('#mode-button')).toBeVisible();
    await expect(page.locator('#theme-toggle')).toBeVisible();
    await expect(page.locator('#permissions-button')).toBeVisible();
    await expect(page.locator('#more-button')).toBeHidden();
  });

  test('As a user, I can open the login QR modal and close it again', async ({ page }) => {
    // Given
    await page.goto(LANDING_URL);
    const backdrop = page.locator('#auth-modal-backdrop');

    // When
    await page.locator('#landing-auth-button').click();

    // Then
    await expect(backdrop).toHaveClass(/\bopen\b/);
    await expect(page.locator('#auth-modal-title')).toBeVisible();

    // When
    await page.locator('#auth-modal-close').click();

    // Then
    await expect(backdrop).not.toHaveClass(/\bopen\b/);
  });

  test('As a user, the theme I pick applies at once and survives a reload', async ({ page }) => {
    // Given
    await page.goto(LANDING_URL);

    // When
    await page.locator('#landing-theme-toggle').click();
    await expect(page.locator('#landing-theme-popover')).toBeVisible();
    await page.locator('[data-theme-option="dark"]').click();

    // Then
    const html = page.locator('html');
    await expect(html).toHaveAttribute('data-theme', 'dark');
    await expect(html).toHaveAttribute('data-theme-pref', 'dark');

    // When
    await page.reload();

    // Then
    await expect(html).toHaveAttribute('data-theme', 'dark');
  });

  test("As a user with a saved theme, the topbar's theme button names it", async ({ page }) => {
    // Given: the build rendered the button for the default, System.
    await page.addInitScript(() => {
      localStorage.setItem('dotli-theme', 'light');
    });

    // When
    await page.goto(LABEL_URL);

    // Then
    await expect(page.locator('#topbar #theme-toggle')).toHaveAttribute('title', 'Theme: Light');
  });

  test("As a user who loses the connection, I see an offline banner that goes away when I'm back", async ({
    page,
    context,
  }) => {
    // Given
    await page.goto(LABEL_URL);
    await expect(page.locator('#topbar')).toBeVisible();
    const banner = page.locator('#offline-banner');

    // When
    await context.setOffline(true);

    // Then
    await expect(banner).toBeVisible();
    await expect(banner).toHaveText('You are offline');

    // When
    await context.setOffline(false);

    // Then
    await expect(banner).toBeHidden();
  });

  test('As a desktop user, I see a toast I can dismiss', async ({ page }) => {
    // Given
    await page.goto(LANDING_URL);
    const card = page.locator('.notif-card', {
      has: page.locator('.notif-title', { hasText: 'Get Polkadot Desktop' }),
    });

    // Then
    await expect(card).toBeVisible();

    // When
    await card.locator('.notif-card-close').click();

    // Then
    await expect(card).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem('desktop-banner-dismissed'))).toBe('1');
  });

  test('As a user with JavaScript disabled, the server-rendered shell still shows the topbar', async ({ browser }) => {
    // Given
    // The topbar is hidden on the landing page by JS (topbar-autohide.ts),
    // so with JS off it stays present instead: this proves the shell is
    // rendered at build time, not painted in by a script.
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();

    // When
    await page.goto(LANDING_URL);

    // Then: the bar is the page's banner landmark.
    await expect(page.getByRole('banner', { name: 'dot.li browser bar' })).toHaveAttribute('id', 'topbar');
    // The hydrated islands' build-time renders.
    await expect(page.locator('#auth-button')).toHaveAttribute('title', 'Login with Polkadot Mobile');
    await expect(page.locator('#theme-toggle')).toHaveAttribute('title', 'Theme: System');

    await context.close();
  });
});
