// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { test as base, expect, type Page, type Frame } from '@playwright/test';
import { existsSync } from 'node:fs';
import { STATE_FILE } from './paths.js';
import { E2E_CHAIN_BACKEND, initializeChainBackend } from '../helpers/chain-backend.js';
import { answerAccountDialog } from '../helpers/signing.js';

const PORT = process.env['PORT'] ?? '5173';
const HOST = process.env['E2E_HOST'] ?? 'host-playground';
const PRODUCT_URL = process.env['E2E_PRODUCT_URL'];

// A restored session shows the badge almost at once, so a tight cap surfaces a broken signer or host fast.
const USER_BADGE_TIMEOUT_MS = 15_000;
// Every new context downloads the product's CAR from the public gateway again, which takes up to ~23s on CI.
const PRODUCT_IFRAME_TIMEOUT_MS = 60_000;
// The product asks for its account right after rendering, and a click during that host modal hits its backdrop.
const HOST_MODAL_SETTLE_TIMEOUT_MS = 15_000;

// The worker's pages that shared the product account. The core keeps the account it fetched for the session, so only
// a worker's first frame is asked, and a host that stops asking fails that worker's first test.
const accountShared = new WeakSet<Page>();

/** The first frame other than `previous` that shows the playground's heading, or null. */
async function visiblePlaygroundFrame(page: Page, previous: Frame | undefined): Promise<Frame | null> {
  for (const frame of page.frames()) {
    if (frame === page.mainFrame() || frame === previous || frame.isDetached()) {
      continue;
    }
    const visible = await frame
      .locator('h1:has-text("Host Playground")')
      .first()
      .isVisible()
      .catch(() => false);
    if (visible) {
      return frame;
    }
  }
  return null;
}

/**
 * Found by its heading, since the frame URL is a per-CID subdomain that varies between builds. With `previous`, the
 * frame that replaced it, as after a device grant rebuilds the product.
 */
export async function waitForHostPlaygroundFrame(page: Page, timeoutMs: number, previous?: Frame): Promise<Frame> {
  const seen: { frame: Frame | null } = { frame: null };
  await expect
    .poll(
      async () => {
        seen.frame = await visiblePlaygroundFrame(page, previous);
        return seen.frame !== null;
      },
      { timeout: timeoutMs, message: `host-playground iframe not visible within ${String(timeoutMs)}ms` },
    )
    .toBe(true);
  if (seen.frame === null) {
    // Narrowing only: the poll above resolves after the callback has set a frame.
    throw new Error('invariant: the poll passed without a host-playground frame');
  }
  return seen.frame;
}

async function waitForHostModalsSettled(page: Page): Promise<void> {
  await expect(page.getByTestId('signing-modal-backdrop')).toHaveCount(0, { timeout: HOST_MODAL_SETTLE_TIMEOUT_MS });
}

/** A test that sends the page to another product calls this to hand the next test a host-playground page. */
export async function openHostPlayground(page: Page): Promise<void> {
  const productHostUrl =
    PRODUCT_URL === undefined
      ? `http://${HOST}.localhost:${PORT}/`
      : `http://localhost:${PORT}/${new URL(PRODUCT_URL).host}`;
  await page.goto(productHostUrl, {
    timeout: 60_000,
  });

  const restoreStart = Date.now();
  await page
    .locator('#auth-button')
    .getByTestId('user-badge')
    .waitFor({ state: 'visible', timeout: USER_BADGE_TIMEOUT_MS });
  console.log(`[pairedPage] session restored in ${String(Date.now() - restoreStart)}ms`);
}

/** Every worker restores the one pairing globalSetup made, so all tests share one signer account. */
export const test = base.extend<{ productFrame: Frame }, { pairedPage: Page }>({
  pairedPage: [
    async ({ browser }, use) => {
      if (!existsSync(STATE_FILE)) {
        throw new Error(
          `pairedPage: ${STATE_FILE} missing — globalSetup must run first. ` +
            `If you ran the test directly, ensure SIGNING_HOST_NETWORK is set ` +
            `and re-run via \`npm run test:e2e\`.`,
        );
      }

      const ctx = await browser.newContext({ storageState: STATE_FILE });
      const page = await ctx.newPage();

      // Filtered to dotli internals, enough to diagnose SDK calls that never resolve without flooding logs.
      page.on('console', msg => {
        const text = msg.text();
        const type = msg.type();
        if (type === 'error' || type === 'warning' || /\[dotli|\[dot\.li|statement.store|signing/i.test(text)) {
          const isFullText =
            type === 'error' ||
            text.includes('polkadotapp://') ||
            text.includes('dot.li signing') ||
            text.includes('session info');
          const out = isFullText ? text : text.slice(0, 400);
          console.log(`[browser:${type}] ${out}`);
        }
      });
      page.on('pageerror', err => {
        console.log(`[browser:pageerror] ${err.message}`);
        if (err.stack !== undefined && err.stack !== '') {
          console.log(`[browser:pageerror:stack] ${err.stack}`);
        }
      });

      // The same backend globalSetup paired on, so the restored localStorage stays consistent.
      await page.addInitScript(initializeChainBackend, E2E_CHAIN_BACKEND);

      // Statement traffic for diagnosing the signing tests, filtered to avoid chain-head spam.
      try {
        const cdp = await ctx.newCDPSession(page);
        await cdp.send('Network.enable');
        cdp.on('Network.webSocketFrameSent', e => {
          const text = e.response.payloadData;
          if (/statement_submit|statement_store|broadcast/i.test(text)) {
            console.log(`[ws→] ${text.slice(0, 500)}`);
          }
        });
        cdp.on('Network.webSocketFrameReceived', e => {
          const text = e.response.payloadData;
          if (/statement_submit|statement_store|"error"|broadcast/i.test(text)) {
            console.log(`[ws←] ${text.slice(0, 500)}`);
          }
        });
      } catch (e) {
        console.log(`[ws] CDP attach failed: ${(e as Error).message}`);
      }

      await openHostPlayground(page);

      await use(page);

      await ctx.close();
    },
    { scope: 'worker' },
  ],

  productFrame: [
    async ({ pairedPage }, use) => {
      const start = Date.now();
      const frame = await waitForHostPlaygroundFrame(pairedPage, PRODUCT_IFRAME_TIMEOUT_MS);
      if (!accountShared.has(pairedPage)) {
        await answerAccountDialog(pairedPage, HOST_MODAL_SETTLE_TIMEOUT_MS);
        // A request made before the fetched account comes back is asked again, so the frame is handed over only once
        // the product holds its account, which the balance card shows as its default address.
        await expect(frame.getByTestId('arg-chain-query-balance-address')).not.toHaveValue('', {
          timeout: HOST_MODAL_SETTLE_TIMEOUT_MS,
        });
        accountShared.add(pairedPage);
      }
      await waitForHostModalsSettled(pairedPage);
      console.log(`[productFrame] iframe ready in ${String(Date.now() - start)}ms`);
      await use(frame);
      // A dialog still open fails the test that left it, not the next one.
      await expect(pairedPage.getByTestId('signing-modal-backdrop')).toHaveCount(0);
    },
    // Test-scoped, since a product handoff or reload replaces the iframe. Its own timeout, since a gateway download
    // can exceed the test's.
    {
      scope: 'test',
      timeout: PRODUCT_IFRAME_TIMEOUT_MS + 3 * HOST_MODAL_SETTLE_TIMEOUT_MS + 10_000,
    },
  ],
});

export { expect } from '@playwright/test';
