// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { test as base, type Page, type Frame } from '@playwright/test';
import { existsSync } from 'node:fs';
import { STATE_FILE } from './paths.js';
import { E2E_CHAIN_BACKEND, initializeChainBackend } from '../helpers/chain-backend.js';

const PORT = process.env['PORT'] ?? '5173';
const HOST = process.env['E2E_HOST'] ?? 'host-playground';
const PRODUCT_URL = process.env['E2E_PRODUCT_URL'];

// A restored session shows the badge almost at once, so a tight cap surfaces a broken signer or host fast.
const USER_BADGE_TIMEOUT_MS = 15_000;
// Every new context downloads the product's CAR from the public gateway again, which takes up to ~23s on CI.
const PRODUCT_IFRAME_TIMEOUT_MS = 60_000;
// The product asks for its account right after rendering, and a click during that host modal hits its backdrop.
const HOST_MODAL_QUIET_MS = 750;
const HOST_MODAL_SETTLE_TIMEOUT_MS = 15_000;

/** Clicks the lasting grant of every permission modal that appears, until stopped. */
function startAutoAllow(page: Page): () => void {
  // A function, since TypeScript would narrow a plain flag set only in the stop closure to `false`.
  const stop = new AbortController();
  const stopped = (): boolean => stop.signal.aborted;
  const POLL_MS = 300;
  void (async () => {
    while (!stopped()) {
      try {
        // Lasting grants only, so a test's later operations are not prompted again.
        const allow = page.getByRole('button', {
          name: /^(Always allow|Allow)$/,
        });
        const visible = await allow
          .first()
          .isVisible({ timeout: POLL_MS })
          .catch(() => false);
        if (visible) {
          await allow
            .first()
            .click({ timeout: 2_000 })
            .catch(() => {});
        } else {
          await page.waitForTimeout(POLL_MS);
        }
      } catch {
        if (!stopped()) {
          await page.waitForTimeout(POLL_MS);
        }
      }
    }
  })();
  return () => {
    stop.abort();
  };
}

/** Found by its heading, since the frame URL is a per-CID subdomain that varies between builds. */
export async function waitForHostPlaygroundFrame(page: Page, timeoutMs: number): Promise<Frame> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const f of page.frames()) {
      if (f === page.mainFrame()) {
        continue;
      }
      const ok = await f
        .locator('h1:has-text("Host Playground")')
        .first()
        .isVisible({ timeout: 500 })
        .catch(() => false);
      if (ok) {
        return f;
      }
    }
    await page.waitForTimeout(250);
  }
  throw new Error(`host-playground iframe not visible within ${String(timeoutMs)}ms`);
}

/** The auto-allow poller answers the prompts meanwhile. */
async function waitForHostModalsSettled(page: Page): Promise<void> {
  const backdrop = page.getByTestId('signing-modal-backdrop');
  const deadline = Date.now() + HOST_MODAL_SETTLE_TIMEOUT_MS;
  let quietSince = Date.now();
  while (Date.now() < deadline) {
    if ((await backdrop.count()) > 0) {
      quietSince = Date.now();
    } else if (Date.now() - quietSince >= HOST_MODAL_QUIET_MS) {
      return;
    }
    await page.waitForTimeout(100);
  }
  console.log(`[productFrame] host modal still open after ${String(HOST_MODAL_SETTLE_TIMEOUT_MS)}ms`);
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
  if (E2E_CHAIN_BACKEND === 'rpc-gateway') {
    await page
      .getByRole('button', { name: 'Switch to Gateway' })
      .click({ timeout: 5_000 })
      .catch(() => {});
  }

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

      // Plain `runTest` reads don't click the permission modal the first signing-capable call opens, and would
      // stick behind its backdrop.
      const stopAutoAllow = startAutoAllow(page);

      await use(page);

      stopAutoAllow();
      await ctx.close();
    },
    { scope: 'worker' },
  ],

  productFrame: [
    async ({ pairedPage }, use) => {
      const start = Date.now();
      const frame = await waitForHostPlaygroundFrame(pairedPage, PRODUCT_IFRAME_TIMEOUT_MS);
      await waitForHostModalsSettled(pairedPage);
      console.log(`[productFrame] iframe ready in ${String(Date.now() - start)}ms`);
      await use(frame);
    },
    // Test-scoped, since a product handoff or reload replaces the iframe. Its own timeout, since a gateway download
    // can exceed the test's.
    {
      scope: 'test',
      timeout: PRODUCT_IFRAME_TIMEOUT_MS + HOST_MODAL_SETTLE_TIMEOUT_MS + 10_000,
    },
  ],
});

export { expect } from '@playwright/test';
