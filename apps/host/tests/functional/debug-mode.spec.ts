// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// How a tab turns the debug panel on and off, and what the panel shares. On the gateway backend with every socket
// refused: the panel needs no product, and the report reads no chain height on the gateway.

import { expect, type Page } from '@playwright/test';
import { PORT } from '../env.js';
import { seedBackend } from './fixtures/settings.js';
import { test } from './helpers/shared-mode-reset.js';

const HOST_URL = `http://host-playground.localhost:${PORT}/`;

test.use({ keepDebugChoice: true });

test.beforeEach(async ({ page }) => {
  await seedBackend(page, 'rpc-gateway');
  await page.context().routeWebSocket(/^wss?:\/\//, socket => socket.close());
});

/** The panel's own root, which says whether it starts collapsed. */
const panel = (page: Page) => page.locator('#truapi-debug-panel');

/** Settings' Advanced category, where the debug row shows only while the tab is out of debug mode. */
async function openAdvancedSettings(page: Page): Promise<void> {
  await expect(page.locator('#topbar-actions[data-collapsible]')).toBeAttached();
  await page.locator('#mode-button').click();
  await page.getByTestId('settings-category-advanced').click();
}

function debugParam(page: Page): string | null {
  return new URL(page.url()).searchParams.get('debug');
}

test('As a developer, I open a tab with ?debug=true and keep the panel open across a reload', async ({ page }) => {
  // When
  await page.goto(`${HOST_URL}?debug=true`);

  // Then
  await expect(page.getByTestId('td-header')).toBeVisible();
  await expect(panel(page)).not.toHaveAttribute('data-collapsed');
  expect(debugParam(page)).toBeNull();

  // When
  await page.reload();

  // Then
  await expect(page.getByTestId('td-header')).toBeVisible();
});

test('As a developer, I leave debug mode with ?debug=off and get the Settings entry back', async ({ page }) => {
  // Given
  await page.goto(`${HOST_URL}?debug=true`);
  await expect(page.getByTestId('td-header')).toBeVisible();

  // When
  await page.goto(`${HOST_URL}?debug=off`);
  await openAdvancedSettings(page);

  // Then
  await expect(page.getByTestId('mode-debug-row')).toBeVisible();
  await expect(page.getByTestId('td-header')).toHaveCount(0);
  expect(debugParam(page)).toBeNull();
});

test('As a user, I open debug mode from Settings and the tab reloads with the panel open', async ({ page }) => {
  // Given
  await page.goto(HOST_URL);
  await openAdvancedSettings(page);

  // When
  const reloaded = page.waitForEvent('load');
  await page.getByTestId('mode-debug-row').getByRole('button', { name: 'Open in debug mode' }).click();
  await reloaded;

  // Then
  await expect(page.getByTestId('td-header')).toBeVisible();
  await expect(panel(page)).not.toHaveAttribute('data-collapsed');
  expect(debugParam(page)).toBeNull();
});

test('As a developer, I close the debug panel and the tab reloads without it', async ({ page }) => {
  // Given
  await page.goto(`${HOST_URL}?debug=true`);
  await expect(page.getByTestId('td-header')).toBeVisible();

  // When
  const reloaded = page.waitForEvent('load');
  await page.getByTestId('td-close').click();
  await reloaded;

  // Then
  await openAdvancedSettings(page);
  await expect(page.getByTestId('mode-debug-row')).toBeVisible();
  await expect(page.getByTestId('td-header')).toHaveCount(0);
});

test('As a developer, I share a diagnostic and get a GitHub issue prefilled with the rows I see', async ({
  page,
  context,
}) => {
  // Given: nothing leaves the machine
  await context.route('https://github.com/**', route =>
    route.fulfill({ contentType: 'text/html', body: '<!DOCTYPE html><html><body>issue</body></html>' }),
  );
  await page.goto(`${HOST_URL}?debug=true`);
  await page.locator('[data-testid="td-section"][data-value="diagnostics"]').click();
  const diagnostics = page.getByTestId('td-diagnostics');
  await expect(diagnostics).toBeVisible();

  // When: the issue opens with `noopener`, so it is a new page of the context and not this page's popup
  const opened = context.waitForEvent('page');
  await diagnostics.getByRole('button', { name: 'Share diagnostic' }).click();
  const issue = await opened;
  await issue.waitForURL('https://github.com/**');

  // Then
  const url = new URL(issue.url());
  expect(`${url.origin}${url.pathname}`).toBe('https://github.com/paritytech/dotli/issues/new');
  const body = url.searchParams.get('body') ?? '';
  expect(body).toContain('## Diagnostics');
  expect(body).toContain(`Site: host-playground.localhost:${PORT}`);
});
