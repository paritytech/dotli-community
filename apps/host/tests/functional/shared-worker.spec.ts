// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Tabs sharing one light client in a SharedWorker. Real network: the first tab syncs Asset Hub from cold.

import { expect, type Browser } from '@playwright/test';
import { DOMAIN, PORT, TIMEOUT_MS } from '../env.js';
import { setupTest } from './helpers/context.js';
import { waitForAppEnd, waitForRenderedSandbox } from './helpers/frames.js';
import { test } from './helpers/shared-mode-reset.js';

const APP_URL = `http://${DOMAIN}.localhost:${PORT}/`;

/** The ids of the browser's SharedWorkers, which tell a worker the tabs rejoined from a new one. */
async function sharedWorkerIds(browser: Browser): Promise<string[]> {
  const cdp = await browser.newBrowserCDPSession();
  try {
    const { targetInfos } = await cdp.send('Target.getTargets');
    return targetInfos.filter(target => target.type === 'shared_worker').map(target => target.targetId);
  } finally {
    await cdp.detach();
  }
}

test.setTimeout(TIMEOUT_MS * 6);

test('As a user who closes one of two tabs and opens it again, the reopened tab joins the light client the other tab still uses', async ({
  browser,
}) => {
  // Given: two tabs on the product, sharing one worker
  const { context, page: first } = await setupTest(browser, { backend: 'smoldot-shared-worker' });
  try {
    await first.goto(APP_URL);
    await waitForRenderedSandbox(first, TIMEOUT_MS * 3);
    const second = await context.newPage();
    await second.goto(APP_URL);
    const secondProduct = await waitForRenderedSandbox(second, TIMEOUT_MS);
    const workers = await sharedWorkerIds(browser);
    expect(workers).toHaveLength(1);

    // When: the first tab leaves through `pagehide`, as a closed tab does, and is opened again
    const closed = first.waitForEvent('close');
    await first.close({ runBeforeUnload: true });
    await closed;
    const reopened = await context.newPage();
    await reopened.goto(APP_URL);

    // Then
    await waitForRenderedSandbox(reopened, TIMEOUT_MS);
    expect(await sharedWorkerIds(browser)).toEqual(workers);
    expect(secondProduct.isDetached()).toBe(false);
    await waitForAppEnd(secondProduct, TIMEOUT_MS);
    await expect(second.getByTestId('error-page-title')).toHaveCount(0);
  } finally {
    await context.close();
  }
});
