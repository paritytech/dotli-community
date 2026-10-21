// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// None of these wait for a chain: they stop at what the shell renders by itself.

import { expect } from '@playwright/test';
import jsQR from 'jsqr';
import { PORT } from '../env.js';
import { seedBackend } from './fixtures/settings.js';
import { productPage, rawBlock } from './helpers/blocks.js';
import { fakeProtocol } from './helpers/fake-protocol.js';
import { isSandboxUrl, waitForRenderedSandbox } from './helpers/frames.js';
import { test } from './helpers/shared-mode-reset.js';

const LANDING_URL = `http://localhost:${PORT}/`;
const LABEL_URL = `http://browse.localhost:${PORT}/`;
const PRODUCT_URL = `http://host-playground.localhost:${PORT}/`;
// 127.0.0.1 because Node on Linux does not resolve *.localhost.
const SHARED_STORE = `http://127.0.0.1:${PORT}/__dotli-mode/`;

test.describe('Shell UI smoke', () => {
  test('As a returning user, the landing page shows my recent sites as a list', async ({ page, request }) => {
    // Given
    const put = await request.put(`${SHARED_STORE}dotli_recent`, {
      data: JSON.stringify(['browse', 'playground']),
    });
    expect(put.ok()).toBe(true);

    // When
    await page.goto(LANDING_URL);

    // Then
    await expect(page.locator('#dotli-nav-form')).toBeVisible();
    await expect(page.locator('body')).toHaveAttribute('data-landing', '');
    const links = page.locator('#dotli-recent').getByTestId('landing-recent-link');
    await expect(links).toHaveCount(2);
    await expect(links.first()).toHaveAttribute('href', /browse/);
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

  test("As a user, the shell's islands hydrate without errors", async ({ page }) => {
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
    await page.waitForFunction(() => document.querySelectorAll('astro-island[ssr]').length === 0);

    // Then: the landing page renders its own auth button, and the topbar's
    // action group, More button included, is gone.
    await expect(page.locator('#landing-auth-button')).toBeVisible();
    await expect(page.locator('#more-button')).toHaveCount(0);
    expect(problems.filter(text => /solid|island|hydrat/i.test(text))).toEqual([]);
  });

  test('As a phone user, the sign-in opens as a sheet and the shell hydrates without warnings', async ({ page }) => {
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
    await page.setViewportSize({ width: 375, height: 812 });

    // When: the idle-hydrated sign-in island has taken over its markup.
    await page.goto(LANDING_URL);
    await page.waitForFunction(() => document.querySelectorAll('astro-island[ssr]').length === 0);
    await page.locator('#landing-auth-button').click();

    // Then
    const frame = page.locator('#auth-modal-backdrop');
    await expect(frame).toHaveAttribute('data-open');
    await expect(frame).toHaveAttribute('data-layout', 'sheet');
    await expect(page.getByTestId('auth-modal-sheet-head')).toBeVisible();
    expect(problems.filter(text => /solid|island|hydrat/i.test(text))).toEqual([]);
  });

  test('As a phone user, the bar shows the actions in place of the address, then the account', async ({ page }) => {
    // Given
    await page.setViewportSize({ width: 390, height: 844 });

    // When
    await page.goto(LABEL_URL);
    await expect(page.locator('#topbar-actions[data-collapsible]')).toBeAttached();

    // Then
    await expect(page.locator('#topbar')).toBeVisible();
    await expect(page.locator('#topbar-url')).toBeHidden();
    await expect(page.locator('#permissions-button')).toBeVisible();
    await expect(page.locator('#mode-button')).toBeVisible();
    await expect(page.locator('#more-button')).toBeHidden();
    await expect(page.locator('#auth-button')).toBeVisible();
    const settingsPrecedesAccount = await page.evaluate(() => {
      const settings = document.querySelector('#mode-button');
      const account = document.querySelector('#auth-button');
      return ((settings?.compareDocumentPosition(account as Node) ?? 0) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    });
    expect(settingsPrecedesAccount).toBe(true);
  });

  test('As a phone user on a bar too narrow for every action, the rest fold into More, which opens as a sheet above the bar that a tap on the scrim closes', async ({
    page,
  }) => {
    // Given
    await page.setViewportSize({ width: 240, height: 640 });

    // When
    await page.goto(LABEL_URL);
    await expect(page.locator('#topbar-actions[data-collapsible]')).toBeAttached();

    // Then
    await expect(page.locator('#auth-button')).toBeVisible();
    await expect(page.locator('#more-button')).toBeVisible();
    await expect(page.locator('#mode-button')).toBeHidden();

    // When
    await page.locator('#more-button').click();

    // Then
    const sheet = page.locator('#more-popover');
    await expect(sheet).toHaveAttribute('data-layout', 'sheet');
    await expect(sheet.getByTestId('menu-sheet-title')).toHaveText('More');
    await expect(sheet).toHaveAttribute('data-open');
    await expect(sheet.getByTestId('menu')).toBeVisible();

    // When
    await page.mouse.click(195, 100);

    // Then
    await expect(sheet).not.toHaveAttribute('data-open');
  });

  test('As a phone user, Settings opens as a bottom sheet, and I can close it with its close button or a swipe', async ({
    page,
  }) => {
    // Given
    await page.setViewportSize({ width: 375, height: 740 });
    await page.goto(LABEL_URL);
    await expect(page.locator('#topbar-actions[data-collapsible]')).toBeAttached();
    const sheet = page.locator('#mode-popover');

    // When
    await page.locator('#mode-button').click();

    // Then
    await expect(sheet).toHaveAttribute('data-layout', 'sheet');
    await expect(sheet).toHaveAttribute('aria-modal', 'true');
    await expect(sheet.getByTestId('popover-sheet-title')).toHaveText('Settings');
    await expect(sheet).toHaveAttribute('data-open');

    // When
    await sheet.getByTestId('popover-sheet-close').click();

    // Then
    await expect(sheet).not.toHaveAttribute('data-open');

    // When: open it again and swipe the header down.
    await page.locator('#mode-button').click();
    await expect(sheet).toHaveAttribute('data-open');
    const header = await sheet.getByTestId('popover-sheet-head').boundingBox();
    const x = (header?.x ?? 0) + (header?.width ?? 0) / 2;
    const y = (header?.y ?? 0) + 10;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y + 400, { steps: 8 });
    await page.mouse.up();

    // Then
    await expect(sheet).not.toHaveAttribute('data-open');
  });

  test('As a phone user, Permissions opens as a bottom sheet with its list and no desktop header', async ({ page }) => {
    // Given
    await page.setViewportSize({ width: 375, height: 740 });
    await page.goto(LABEL_URL);
    await expect(page.locator('#topbar-actions[data-collapsible]')).toBeAttached();
    const sheet = page.locator('#permissions-popover');

    // When
    await page.locator('#permissions-button').click();

    // Then
    await expect(sheet).toHaveAttribute('data-open');
    await expect(sheet).toHaveAttribute('data-layout', 'sheet');
    await expect(sheet).toHaveAttribute('aria-modal', 'true');
    await expect(sheet.getByTestId('popover-sheet-title')).toHaveText('Permissions');
    await expect(sheet.locator('#permissions-popover-list')).toBeAttached();
    await expect(sheet.getByTestId('permissions-popover-header')).toHaveCount(0);
  });

  test('As a desktop user, Permissions opens anchored under the topbar', async ({ page }) => {
    // Given
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(LABEL_URL);
    await expect(page.locator('#topbar-actions[data-collapsible]')).toBeAttached();

    // When
    await page.locator('#permissions-button').click();

    // Then
    const popover = page.locator('#permissions-popover');
    await expect(popover).toHaveAttribute('data-open');
    // The anchored form: a shown popover element, not the sheet's dialog.
    await expect(page.locator('#permissions-popover:popover-open')).toBeAttached();
    const box = await popover.boundingBox();
    expect(box?.y ?? 0).toBeLessThan(100);
  });

  test('As a desktop user, every topbar button fits and there is no More button', async ({ page }) => {
    // Given
    await page.setViewportSize({ width: 1280, height: 800 });

    // When
    await page.goto(LABEL_URL);
    await expect(page.locator('#topbar-actions[data-collapsible]')).toBeAttached();
    await expect(page.locator('body')).not.toHaveAttribute('data-landing');

    // Then
    await expect(page.locator('#mode-button')).toBeVisible();
    await expect(page.locator('#permissions-button')).toBeVisible();
    await expect(page.locator('#more-button')).toBeHidden();
  });

  test('As a user, I can open the login QR modal and close it again', async ({ page }) => {
    // Given: the idle-hydrated sign-in island has taken over its markup.
    await page.goto(LANDING_URL);
    await page.waitForFunction(() => document.querySelectorAll('astro-island[ssr]').length === 0);
    const backdrop = page.locator('#auth-modal-backdrop');

    // When
    await page.locator('#landing-auth-button').click();

    // Then
    await expect(backdrop).toHaveAttribute('data-open');
    await expect(page.locator('#auth-modal-title')).toBeVisible();

    // When
    await page.locator('#auth-modal-close').click();

    // Then
    await expect(backdrop).not.toHaveAttribute('data-open');
  });

  test('As a user, the theme I pick applies at once and survives a reload', async ({ page }) => {
    // Given
    await page.goto(LABEL_URL);

    // When: the settings open on General, where the theme is.
    await page.locator('#topbar #mode-button').click();
    await expect(page.locator('#mode-popover')).toBeVisible();
    await page.getByTestId('theme-option-dark').click();

    // Then
    const html = page.locator('html');
    await expect(html).toHaveAttribute('data-theme', 'dark');
    await expect(html).toHaveAttribute('data-theme-pref', 'dark');

    // When
    await page.reload();

    // Then
    await expect(html).toHaveAttribute('data-theme', 'dark');
  });

  test('As a user with a saved theme, I see it checked in the settings', async ({ page }) => {
    // Given
    await page.addInitScript(() => {
      localStorage.setItem('dotli-theme', 'light');
    });
    await page.goto(LABEL_URL);

    // When
    await page.locator('#topbar #mode-button').click();

    // Then
    await expect(page.getByTestId('theme-option-light')).toHaveAttribute('aria-pressed', 'true');
  });

  test("As a user who loses the connection, the bar's status turns red and recovers when I'm back", async ({
    page,
    context,
  }) => {
    // Given
    await page.goto(LABEL_URL);
    const bar = page.locator('#topbar');
    await expect(bar).toBeVisible();

    // When
    await context.setOffline(true);

    // Then
    await expect(bar).toHaveAttribute('data-tone', 'err');

    // When
    await context.setOffline(false);

    // Then
    await expect(bar).not.toHaveAttribute('data-tone', 'err');
  });

  test('As a desktop user, I see a toast I can dismiss and it stays gone after a reload', async ({ page }) => {
    // Given
    await page.goto(LANDING_URL);
    const card = page.getByTestId('notif-card').filter({
      has: page.getByTestId('notif-title').filter({ hasText: 'Get Polkadot Desktop' }),
    });

    // Then
    await expect(card).toBeVisible();
    await expect(card.getByTestId('notif-icon')).toHaveAttribute('data-tone', 'info');

    // When
    await card.getByTestId('notif-card-close').click();

    // Then
    await expect(card).toHaveCount(0);

    // When
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll('astro-island[ssr]').length === 0);

    // Then
    await expect(card).toHaveCount(0);
  });

  test('As a desktop user, a part of the app that fails to load offers a reload in an error toast', async ({
    page,
  }) => {
    // Given
    await page.goto(LANDING_URL);

    // When
    await page.evaluate(() => window.dispatchEvent(new Event('vite:preloadError')));

    // Then
    const card = page.getByTestId('notif-card').filter({
      has: page.getByTestId('notif-title').filter({ hasText: 'Asset failed to load' }),
    });
    await expect(card.getByTestId('notif-icon')).toHaveAttribute('data-tone', 'err');
    await expect(card.getByTestId('notif-action')).toHaveText('Reload');
  });

  test('As a user with JavaScript disabled, the server-rendered shell still shows the topbar', async ({ browser }) => {
    // Given: with JS off nothing can paint the bar in, so finding it proves it is rendered at build time.
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();

    // When
    await page.goto(LABEL_URL);

    // Then: the bar is the page's banner landmark.
    await expect(page.getByRole('banner', { name: 'dot.li browser bar' })).toHaveAttribute('id', 'topbar');
    // The hydrated islands' build-time renders: the account button before the saved session is read.
    await expect(page.locator('#auth-button')).toHaveAttribute('title', 'Checking sign-in');

    await context.close();
  });

  test('As a visitor, the landing page is the first paint, with no browser bar, before any script runs', async ({
    browser,
  }) => {
    // Given: with JS off the page stays as the server sent it.
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();

    // When
    await page.goto(LANDING_URL);

    // Then
    await expect(page.getByTestId('landing')).toBeVisible();
    await expect(page.getByRole('banner', { name: 'dot.li browser bar' })).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 1, name: 'Polkadot' })).toBeVisible();
    await expect(page.getByText('The decentralized web, in your browser.')).toBeVisible();
    // The islands' build-time renders.
    await expect(page.locator('#landing-auth-button')).toBeVisible();
    await expect(page.locator('#dotli-nav-input')).toBeVisible();

    await context.close();
  });
  test('As a returning user, I remove a site from my recent list and it stays removed', async ({ page, request }) => {
    // Given
    const put = await request.put(`${SHARED_STORE}dotli_recent`, {
      data: JSON.stringify(['browse', 'playground']),
    });
    expect(put.ok()).toBe(true);
    await page.goto(LANDING_URL);
    const links = page.locator('#dotli-recent').getByTestId('landing-recent-link');
    await expect(links).toHaveCount(2);

    // When
    await links.first().hover();
    await page.getByRole('button', { name: /^Remove browse/ }).click();

    // Then
    await expect(links).toHaveCount(1);
    await expect(links.first()).toHaveAttribute('href', /playground/);
    await expect
      .poll(async () => (await request.get(`${SHARED_STORE}dotli_recent`)).text())
      .toBe(JSON.stringify(['playground']));

    // When
    await page.reload();

    // Then
    await expect(links).toHaveCount(1);
  });

  test('As a user on a product, I open the network popover and see how the chains stand', async ({ page }) => {
    // Given
    const block = await rawBlock(productPage('chains'));
    await seedBackend(page, 'smoldot-direct');
    await fakeProtocol(page, { resolve: { kind: 'cid', cid: block.cid }, blocks: { [block.cid]: block.hex } });
    await page.goto(PRODUCT_URL);
    await waitForRenderedSandbox(page, 15_000);
    const popover = page.locator('#chains-popover');

    // When
    await page.getByRole('button', { name: 'Network' }).click();

    // Then
    await expect(popover).toHaveAttribute('data-open');
    await expect(popover.getByTestId('chains-content')).toBeVisible();
    await expect(popover.getByTestId('chains-status-title')).toHaveText('No chains in use');

    // When
    await page.keyboard.press('Escape');

    // Then
    await expect(popover).not.toHaveAttribute('data-open');
  });

  test('As a user on a product, the shell and its sandbox come with the framing headers production sends', async ({
    page,
  }) => {
    // Given
    const block = await rawBlock(productPage('headers'));
    await seedBackend(page, 'smoldot-direct');
    await fakeProtocol(page, { resolve: { kind: 'cid', cid: block.cid }, blocks: { [block.cid]: block.hex } });
    const shellDocument = page.waitForResponse(response => response.url() === PRODUCT_URL);
    const sandboxDocument = page.waitForResponse(
      response => response.request().resourceType() === 'document' && isSandboxUrl(response.url()),
    );

    // When
    await page.goto(PRODUCT_URL);
    await waitForRenderedSandbox(page, 15_000);

    // Then
    expect((await shellDocument).headers()['x-frame-options']).toBe('SAMEORIGIN');
    const sandbox = (await sandboxDocument).headers();
    expect(sandbox['content-security-policy']).toBe('frame-ancestors http://localhost:* http://*.localhost:*');
    expect(sandbox['cross-origin-embedder-policy']).toBe('credentialless');
  });

  test('As a user on a light client, I hover the shield while my product downloads and read that it was verified', async ({
    page,
  }) => {
    // Given: the content never arrives, so the bar stays unfolded over the loading screen
    const block = await rawBlock(productPage('shield'));
    await seedBackend(page, 'smoldot-direct');
    await fakeProtocol(page, {
      resolve: { kind: 'cid', cid: block.cid },
      blocks: { [block.cid]: block.hex },
      modes: { [block.cid]: 'hold' },
    });
    await page.goto(PRODUCT_URL);
    const shield = page.getByRole('button', { name: 'Site verification' });
    await expect(shield).toHaveAttribute('data-state', 'verified', { timeout: 15_000 });

    // When
    await shield.hover();

    // Then
    await expect(page.getByTestId('verification-tooltip-row-verified')).toBeVisible();
  });

  test('As a visitor signing in, I see a QR code that carries the pairing link', async ({ page }) => {
    // Given: the idle-hydrated sign-in island has taken over its markup.
    await page.goto(LANDING_URL);
    await page.waitForFunction(() => document.querySelectorAll('astro-island[ssr]').length === 0);

    // When
    await page.locator('#landing-auth-button').click();

    // Then
    const canvas = page.getByTestId('auth-modal-qr-tile').locator('canvas');
    await expect(canvas).toHaveAttribute('data-qr-payload', /^polkadotapp:\/\//, { timeout: 15_000 });
    const payload = await canvas.getAttribute('data-qr-payload');
    const pixels = await canvas.evaluate((node: HTMLCanvasElement) => {
      const image = node.getContext('2d')?.getImageData(0, 0, node.width, node.height);
      return image === undefined ? null : { data: [...image.data], width: image.width, height: image.height };
    });
    expect(pixels).not.toBeNull();
    const decoded = jsQR(new Uint8ClampedArray(pixels?.data ?? []), pixels?.width ?? 0, pixels?.height ?? 0);
    expect(decoded?.data).toBe(payload);
  });
});
