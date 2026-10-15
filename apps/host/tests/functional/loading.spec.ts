// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  HOST_ERRORS,
  FAILOVER_BTN_LABELS,
  GO_BACK_BTN_LABEL,
  OPEN_SETTINGS_BTN_LABEL,
  RELOAD_BTN_LABEL,
  ERROR_TITLES,
  TRY_ANYWAY_BTN_LABEL,
} from '../../src/error-copy.js';
import { test } from './helpers/shared-mode-reset.js';
import {
  errorResolveResponse,
  fatalOnResolve,
  initFailed,
  mockProtocolIframe,
  nullResolveResponse,
  successfulResolveResponse,
} from './helpers/fake-protocol.js';
import { findAppFrame } from '../product-frame.js';
import { seedBackend, type Backend } from './fixtures/settings.js';

import { PORT, TLD_SUFFIX } from '../env.js';

const DOMAIN = process.env['COMBO_DOMAIN'] ?? 'host-playground';
const HOST_URL = `http://${DOMAIN}.localhost:${PORT}/`;

// The first sighting of a failure offers Settings, only a repeat of the same kind offers the one-click switch.
const RETRY_LABEL_FROM_SMOLDOT = FAILOVER_BTN_LABELS['rpc-gateway'];

// Keeps the backend the in-page retry button flipped.
async function setBackend(page: Page, backend: Backend): Promise<void> {
  await seedBackend(page, backend, { onlyIfUnset: true });
}

test('As a user using smoldot directly, when the light client panics mid-resolution, I see the appropriate error and can switch backend', async ({
  page,
}) => {
  // Given
  await setBackend(page, 'smoldot-direct');
  await mockProtocolIframe(page, fatalOnResolve('smoldot panic'));

  // When
  await page.goto(HOST_URL, { waitUntil: 'domcontentloaded' });

  // Then
  await expect(page.getByTestId('error-page-title')).toHaveText(ERROR_TITLES.DOMAIN_UNREACHABLE, {
    timeout: 10_000,
  });
  await expect(page.getByTestId('error-page-detail')).toHaveText(HOST_ERRORS.FATAL_PANIC);
  await expect(page.locator('#error-retry-btn')).toContainText(RELOAD_BTN_LABEL);
  await expect(page.locator('#error-retry-btn-1')).toContainText(OPEN_SETTINGS_BTN_LABEL);
});

test("As a user using smoldot in shared worker, when the browser can't create a worker, I see the appropriate error and can switch backend", async ({
  page,
}) => {
  // Given
  await setBackend(page, 'smoldot-shared-worker');
  await mockProtocolIframe(page, initFailed('SharedWorker is not available in this browser'));

  // When
  await page.goto(HOST_URL, { waitUntil: 'domcontentloaded' });

  // Then
  await expect(page.getByTestId('error-page-title')).toHaveText(ERROR_TITLES.DOMAIN_UNREACHABLE, {
    timeout: 10_000,
  });
  await expect(page.getByTestId('error-page-detail')).toHaveText(HOST_ERRORS.SW_FAILED_TO_START);
  await expect(page.locator('#error-retry-btn')).toContainText(RELOAD_BTN_LABEL);
  await expect(page.locator('#error-retry-btn-1')).toContainText(OPEN_SETTINGS_BTN_LABEL);
});

test('As a user using smoldot in shared worker, when the worker dies silently, I see the appropriate error and can switch backend', async ({
  page,
}) => {
  // Given
  await setBackend(page, 'smoldot-shared-worker');
  await mockProtocolIframe(page, initFailed('SharedWorker did not signal ready within timeout'));

  // When
  await page.goto(HOST_URL, { waitUntil: 'domcontentloaded' });

  // Then
  await expect(page.getByTestId('error-page-title')).toHaveText(ERROR_TITLES.DOMAIN_UNREACHABLE, {
    timeout: 10_000,
  });
  await expect(page.getByTestId('error-page-detail')).toHaveText(HOST_ERRORS.SW_TIMED_OUT);
  await expect(page.locator('#error-retry-btn')).toContainText(RELOAD_BTN_LABEL);
  await expect(page.locator('#error-retry-btn-1')).toContainText(OPEN_SETTINGS_BTN_LABEL);
});

test('As a user using smoldot directly, when the sync times out (>45s) I see the appropriate error and can switch backend', async ({
  page,
}) => {
  // Given
  await setBackend(page, 'smoldot-direct');
  await mockProtocolIframe(
    page,
    errorResolveResponse(
      'Sync to Asset Hub Paseo timed out after 45s. Unable to reach peers.',
      1_500,
      'NetworkSyncTimeoutError',
    ),
  );

  // When
  await page.goto(HOST_URL, { waitUntil: 'domcontentloaded' });

  // Then
  await expect(page.getByTestId('error-page-title')).toHaveText(ERROR_TITLES.DOMAIN_UNREACHABLE, {
    timeout: 10_000,
  });
  await expect(page.getByTestId('error-page-detail')).toHaveText(HOST_ERRORS.HUB_SYNC_TIMEOUT);
  await expect(page.locator('#error-retry-btn')).toContainText(RELOAD_BTN_LABEL);
  await expect(page.locator('#error-retry-btn-1')).toContainText(OPEN_SETTINGS_BTN_LABEL);
});

test('As a user using smoldot directly, when every peer WebSocket is unavailable, I see a typed Hub failure before the generic request timeout', async ({
  page,
}) => {
  // Given
  await setBackend(page, 'smoldot-direct');
  await page.addInitScript(() => {
    sessionStorage.setItem('dotli:resolve-budget-ms', '1000');
  });
  let blockedSockets = 0;
  await page.context().routeWebSocket(/^wss?:\/\//, socket => {
    blockedSockets += 1;
    void socket.close();
  });

  // When
  await page.goto(HOST_URL, { waitUntil: 'domcontentloaded' });

  // Then
  await expect(page.getByTestId('error-page-title')).toHaveText(ERROR_TITLES.DOMAIN_UNREACHABLE, {
    timeout: 30_000,
  });
  await expect(page.getByTestId('error-page-detail')).toHaveText(HOST_ERRORS.HUB_SYNC_TIMEOUT);
  await expect(page.locator('#error-retry-btn-1')).toContainText(OPEN_SETTINGS_BTN_LABEL);
  expect(blockedSockets).toBeGreaterThan(0);
});

test('As a user, when the app chunks fail to load mid-session, I see the appropriate error with a reload button', async ({
  page,
}) => {
  // Given: the gateway backend, the one whose name reads load a chunk after boot
  await setBackend(page, 'rpc-gateway');
  await page.route('**/assets/resolve.*.js', route => route.abort());

  // When
  await page.goto(HOST_URL, { waitUntil: 'domcontentloaded' });

  // Then
  await expect(page.getByTestId('error-page-title')).toHaveText(ERROR_TITLES.DOMAIN_UNREACHABLE, {
    timeout: 10_000,
  });
  await expect(page.getByTestId('error-page-detail')).toHaveText(HOST_ERRORS.MODULE_FETCH_FAILED);
  await expect(page.locator('#error-retry-btn')).toContainText('Reload');
});

test('As a user using smoldot directly, when smoldot rejects the chain spec, I see the appropriate error and can switch backend', async ({
  page,
}) => {
  // Given
  await setBackend(page, 'smoldot-direct');
  await mockProtocolIframe(page, initFailed('Chain spec rejected: invalid checkpoint'));

  // When
  await page.goto(HOST_URL, { waitUntil: 'domcontentloaded' });

  // Then
  await expect(page.getByTestId('error-page-title')).toHaveText(ERROR_TITLES.DOMAIN_UNREACHABLE, {
    timeout: 10_000,
  });
  await expect(page.getByTestId('error-page-detail')).toHaveText(HOST_ERRORS.CHAIN_SPEC_REJECTED);
  await expect(page.locator('#error-retry-btn')).toContainText(RELOAD_BTN_LABEL);
  await expect(page.locator('#error-retry-btn-1')).toContainText(OPEN_SETTINGS_BTN_LABEL);
});

test('As a user, when I visit a domain that has no content set, I see the appropriate message with the domain label', async ({
  page,
}) => {
  // Given
  await setBackend(page, 'smoldot-direct');
  await mockProtocolIframe(page, nullResolveResponse);

  // When
  await page.goto(HOST_URL, { waitUntil: 'domcontentloaded' });

  // Then
  await expect(page.getByTestId('error-page-title')).toHaveText("This app can't be reached", { timeout: 10_000 });
  await expect(page.getByTestId('error-page-domain')).toHaveText(`${DOMAIN}${TLD_SUFFIX}`);
  await expect(page.getByTestId('error-page-detail')).toContainText('Check if there is a typo');
  await expect(page.locator('#error-retry-btn')).toHaveCount(0);
});

test("As a user, when the domain's contenthash is unsupported or malformed, I see the appropriate error with no retry button", async ({
  page,
}) => {
  // Given
  await setBackend(page, 'smoldot-direct');
  await mockProtocolIframe(page, errorResolveResponse('Failed to decode contenthash for example: bad codec'));

  // When
  await page.goto(HOST_URL, { waitUntil: 'domcontentloaded' });

  // Then
  await expect(page.getByTestId('error-page-title')).toHaveText(ERROR_TITLES.DOMAIN_UNREACHABLE, {
    timeout: 10_000,
  });
  await expect(page.getByTestId('error-page-detail')).toHaveText(HOST_ERRORS.CONTENTHASH_UNSUPPORTED);
  await expect(page.locator('#error-retry-btn')).toHaveCount(0);
});

test('As a user, when the same failure survives a reload, the error page escalates from Settings to a one-click backend switch', async ({
  page,
}) => {
  // Given
  await setBackend(page, 'smoldot-direct');
  await mockProtocolIframe(page, fatalOnResolve('smoldot panic'));
  await page.goto(HOST_URL, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('error-page-title')).toHaveText(ERROR_TITLES.DOMAIN_UNREACHABLE, {
    timeout: 10_000,
  });
  await expect(page.locator('#error-retry-btn-1')).toContainText(OPEN_SETTINGS_BTN_LABEL);

  // When
  // Armed before the click: `waitForLoadState` after it can resolve against
  // the document that is about to be torn down, which would let the assertions
  // below read the pre-reload screen.
  const reloaded = page.waitForEvent('load');
  await page.locator('#error-retry-btn').click();
  await reloaded;

  // Then
  await expect(page.getByTestId('error-page-title')).toHaveText(ERROR_TITLES.DOMAIN_UNREACHABLE, {
    timeout: 10_000,
  });
  await expect(page.locator('#error-retry-btn-1')).toContainText(RETRY_LABEL_FROM_SMOLDOT);
});

test('As a user, after a resolution failure, clicking retry switches backend', async ({ page }) => {
  // Given
  await setBackend(page, 'smoldot-direct');
  await mockProtocolIframe(page, fatalOnResolve('smoldot panic'));
  await page.goto(HOST_URL, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('error-page-title')).toHaveText(ERROR_TITLES.DOMAIN_UNREACHABLE, {
    timeout: 10_000,
  });
  // The switch is offered only on the second sighting.
  const secondSighting = page.waitForEvent('load');
  await page.locator('#error-retry-btn').click();
  await secondSighting;
  await expect(page.locator('#error-retry-btn-1')).toContainText(RETRY_LABEL_FROM_SMOLDOT, { timeout: 10_000 });
  const backendBefore = await page.evaluate(() => localStorage.getItem('dotli:chain-backend'));
  expect(backendBefore).toBe('smoldot-direct');

  // When
  await page.locator('#error-retry-btn-1').click();
  // Dropping verification is confirmed first, and `Try Anyway` leads, so it keeps `#error-retry-btn`.
  await expect(page.locator('#error-retry-btn')).toContainText(TRY_ANYWAY_BTN_LABEL);
  await expect(page.locator('#error-retry-btn-1')).toContainText(GO_BACK_BTN_LABEL);
  const switched = page.waitForEvent('load');
  await page.locator('#error-retry-btn').click();
  await switched;

  // Then
  const backendAfter = await page.evaluate(() => localStorage.getItem('dotli:chain-backend'));
  expect(backendAfter).toBe('rpc-gateway');
});

test('As a user, after a resolution failure, I can refresh instead of switching backend, and the backend stays unchanged', async ({
  page,
}) => {
  // Given
  await setBackend(page, 'smoldot-direct');
  await mockProtocolIframe(page, fatalOnResolve('smoldot panic'));
  await page.goto(HOST_URL, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('error-page-title')).toHaveText(ERROR_TITLES.DOMAIN_UNREACHABLE, {
    timeout: 10_000,
  });
  const refresh = page.locator('#error-retry-btn');
  await expect(refresh).toContainText(RELOAD_BTN_LABEL);
  await expect(page.locator('#error-retry-btn-1')).toContainText(OPEN_SETTINGS_BTN_LABEL);

  // When
  // Armed before the click, so the assertions below read the new document.
  const reloaded = page.waitForEvent('load');
  await refresh.click();
  await reloaded;

  // Then
  await expect(page.getByTestId('error-page-title')).toHaveText(ERROR_TITLES.DOMAIN_UNREACHABLE, {
    timeout: 10_000,
  });
  const backendAfter = await page.evaluate(() => localStorage.getItem('dotli:chain-backend'));
  expect(backendAfter).toBe('smoldot-direct');
});

for (const [label, backend] of [
  ['per-product smoldot', 'smoldot-direct'],
  ['shared smoldot', 'smoldot-shared-worker'],
] as const) {
  test(`As a user using ${label}, the host shell spawns no light client of its own`, async ({ page }) => {
    // Given
    await setBackend(page, backend);
    await mockProtocolIframe(page, successfulResolveResponse('bafyfakebafyfakebafyfakebafyfakebafyfakebafyfa'));
    const workerUrls: string[] = [];
    page.on('worker', worker => {
      workerUrls.push(worker.url());
    });

    // When
    await page.goto(HOST_URL, { waitUntil: 'domcontentloaded' });
    await findAppFrame(page, 10_000);

    // Then
    const hostShellOrigin = `http://${DOMAIN}.localhost:${PORT}`;
    const hostShellSmoldotWorkers = workerUrls.filter(
      url => url.startsWith(hostShellOrigin) && url.includes('smoldot_worker'),
    );
    expect(
      hostShellSmoldotWorkers,
      `host shell must not spawn a smoldot worker. apps/protocol owns smoldot. Found at host-shell origin:\n${hostShellSmoldotWorkers.join('\n')}`,
    ).toEqual([]);
  });
}

test('As a user who opens Settings from a failure before the topbar is ready, I see Settings open once it is', async ({
  page,
}) => {
  // Given: the topbar's actions island cannot hydrate until the test lets its chunk through
  await setBackend(page, 'smoldot-direct');
  await mockProtocolIframe(page, fatalOnResolve('smoldot panic'));
  let releaseIsland = (): void => undefined;
  const islandReleased = new Promise<void>(resolve => {
    releaseIsland = resolve;
  });
  await page.route('**/assets/TopbarActions.*.js', async route => {
    await islandReleased;
    await route.continue();
  });
  await page.goto(HOST_URL, { waitUntil: 'domcontentloaded' });
  const openSettings = page.getByTestId('error-page').getByRole('button', { name: OPEN_SETTINGS_BTN_LABEL });
  await expect(openSettings).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('astro-island[component-url*="TopbarActions"][ssr]')).toBeAttached();

  // When
  await openSettings.click();
  releaseIsland();

  // Then
  await expect(page.locator('#mode-popover')).toHaveAttribute('data-open');
});

test('As a user who opens Settings from a failure once the topbar is ready, I see Settings open', async ({ page }) => {
  // Given
  await setBackend(page, 'smoldot-direct');
  await mockProtocolIframe(page, fatalOnResolve('smoldot panic'));
  await page.goto(HOST_URL, { waitUntil: 'domcontentloaded' });
  const openSettings = page.getByTestId('error-page').getByRole('button', { name: OPEN_SETTINGS_BTN_LABEL });
  await expect(openSettings).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('#topbar-actions[data-collapsible]')).toBeAttached();

  // When
  await openSettings.click();

  // Then
  await expect(page.locator('#mode-popover')).toHaveAttribute('data-open');
});
