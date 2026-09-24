// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { test as base, type Page, type Frame } from "@playwright/test";
import { existsSync } from "node:fs";
import { STATE_FILE } from "./paths";
import {
  E2E_CHAIN_BACKEND,
  initializeChainBackend,
} from "../helpers/chain-backend";

const PORT = process.env.PORT ?? "5173";
const HOST = process.env.E2E_HOST ?? "host-playground";
const PRODUCT_URL = process.env.E2E_PRODUCT_URL;

// Restored-session badge wait. The signing host was paired once in
// globalSetup, the storageState restores the host's auth on every context,
// so seeing the user-badge should be near-instant. A tight cap surfaces a
// broken signer or host fast instead of running out the workflow clock.
const USER_BADGE_TIMEOUT_MS = 15_000;
// A fresh page downloads the product's CAR from the public IPFS gateway,
// which takes 4-23 s from CI runners (about 1 s locally). The SW archive
// cache does not survive into a new browser context, so every worker start
// pays it again.
const PRODUCT_IFRAME_TIMEOUT_MS = 60_000;
// A fresh page's product asks for its product account right after it
// renders, which opens a blocking host modal over the iframe. A click that
// lands while it is up hits the backdrop instead of the product.
const HOST_MODAL_QUIET_MS = 750;
const HOST_MODAL_SETTLE_TIMEOUT_MS = 15_000;

/**
 * Background poller that dismisses the host's "Permission Request" modal
 * by clicking its lasting-grant button as soon as one appears. Idempotent: a
 * dismissed modal that re-opens later (different permission, different
 * test) is dismissed again. Returns a stop function that cancels the
 * loop on fixture teardown.
 */
function startAutoAllow(page: Page): () => void {
  let stopped = false;
  const POLL_MS = 300;
  void (async () => {
    while (!stopped) {
      try {
        // Three-way prompts label the lasting grant "Always allow"; two-way
        // ones keep "Allow". Neither picks the one-time grant, so a test's
        // later operations are not prompted again.
        const allow = page.getByRole("button", {
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
        if (!stopped) await page.waitForTimeout(POLL_MS);
      }
    }
  })();
  return () => {
    stopped = true;
  };
}

/**
 * Wait until the host-playground product iframe has mounted and rendered.
 * Identified by its `<h1>` heading rather than URL because the frame URL
 * lives on a per-CID subdomain that varies between builds.
 */
export async function waitForHostPlaygroundFrame(
  page: Page,
  timeoutMs: number,
): Promise<Frame> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const f of page.frames()) {
      if (f === page.mainFrame()) continue;
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
  throw new Error(
    `host-playground iframe not visible within ${String(timeoutMs)}ms`,
  );
}

/**
 * Wait until no blocking host modal has been open for `HOST_MODAL_QUIET_MS`.
 * The auto-allow poller answers permission and account prompts meanwhile.
 */
async function waitForHostModalsSettled(page: Page): Promise<void> {
  const backdrop = page.locator(".signing-modal-backdrop");
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
  console.log(
    `[productFrame] host modal still open after ${String(HOST_MODAL_SETTLE_TIMEOUT_MS)}ms`,
  );
}

/**
 * Load host-playground in dot.li on `page` and wait for the restored session.
 * The fixture opens the worker's page with it, and a test that sends the page
 * to another product calls it to hand the next test a host-playground page.
 */
export async function openHostPlayground(page: Page): Promise<void> {
  const productHostUrl =
    PRODUCT_URL === undefined
      ? `http://${HOST}.localhost:${PORT}/`
      : `http://localhost:${PORT}/${new URL(PRODUCT_URL).host}`;
  await page.goto(productHostUrl, {
    timeout: 60_000,
  });
  if (E2E_CHAIN_BACKEND === "rpc-gateway") {
    await page
      .getByRole("button", { name: "Switch to Gateway" })
      .click({ timeout: 5_000 })
      .catch(() => {});
  }

  const restoreStart = Date.now();
  await page
    .locator("#auth-button .user-badge")
    .waitFor({ state: "visible", timeout: USER_BADGE_TIMEOUT_MS });
  console.log(
    `[pairedPage] session restored in ${Date.now() - restoreStart}ms`,
  );
}

/**
 * Worker-scoped fixtures: open a fresh page that inherits the
 * once-per-run signing-host pairing via `storageState` written by
 * globalSetup. No QR scan, no CLI spawn here. If the badge doesn't appear
 * inside 15 s the worker fails fast. The signing host is either dead or
 * the host can't restore auth from the saved state.
 *
 * State sharing: every worker reads the same `.auth/state.json`, so all
 * tests across the run share one signer account. This matches the prior
 * behavior under `workers: 1` (worker-scope pairing) and avoids the
 * re-pair cascade that previously timed out CI on a single test failure.
 */
export const test = base.extend<{ productFrame: Frame }, { pairedPage: Page }>({
  pairedPage: [
    async ({ browser }, use) => {
      if (!existsSync(STATE_FILE)) {
        throw new Error(
          `pairedPage: ${STATE_FILE} missing — globalSetup must run first. ` +
            `If you ran the test directly, ensure SIGNING_HOST_NETWORK is set ` +
            `and re-run via \`bun run test:e2e\`.`,
        );
      }

      const ctx = await browser.newContext({ storageState: STATE_FILE });
      const page = await ctx.newPage();

      // Surface host and iframe console noise filtered to dotli internals so
      // we can diagnose SDK calls that never resolve without flooding logs.
      page.on("console", (msg) => {
        const text = msg.text();
        const type = msg.type();
        if (
          type === "error" ||
          type === "warning" ||
          /\[dotli|\[dot\.li|statement.store|signing/i.test(text)
        ) {
          const isFullText =
            type === "error" ||
            text.includes("polkadotapp://") ||
            text.includes("dot.li signing") ||
            text.includes("session info");
          const out = isFullText ? text : text.slice(0, 400);
          console.log(`[browser:${type}] ${out}`);
        }
      });
      page.on("pageerror", (err) => {
        console.log(`[browser:pageerror] ${err.message}`);
        if (err.stack) {
          console.log(`[browser:pageerror:stack] ${err.stack}`);
        }
      });

      // Mirror the init flags globalSetup used so the page boots into the
      // same backend mode and the restored localStorage stays consistent.
      await page.addInitScript(initializeChainBackend, E2E_CHAIN_BACKEND);

      // WebSocket frames: statement_submit / broadcast traffic for
      // diagnosing the signing tests. Filtered to avoid chain-head spam.
      try {
        const cdp = await ctx.newCDPSession(page);
        await cdp.send("Network.enable");
        cdp.on("Network.webSocketFrameSent", (e) => {
          const text = e.response.payloadData;
          if (/statement_submit|statement_store|broadcast/i.test(text)) {
            console.log(`[ws→] ${text.slice(0, 500)}`);
          }
        });
        cdp.on("Network.webSocketFrameReceived", (e) => {
          const text = e.response.payloadData;
          if (
            /statement_submit|statement_store|"error"|broadcast/i.test(text)
          ) {
            console.log(`[ws←] ${text.slice(0, 500)}`);
          }
        });
      } catch (e) {
        console.log(`[ws] CDP attach failed: ${(e as Error).message}`);
      }

      await openHostPlayground(page);

      // Auto-allow Permission Request modals.
      //
      // The first signing-capable product call (e.g. `getProductAccount`,
      // `requestResourceAllocation`) triggers the host's "Permission
      // Request" modal asking the user to grant `AutoSigning` / similar.
      // `runWebSignedTest` knows to click "Allow"; plain `runTest` reads
      // (Get Product Account, Chain Spec, Contract Query, …) don't, and
      // get stuck behind the modal backdrop. Run a low-rate poller that
      // dismisses any Allow button that appears, so every test path
      // works regardless of whether the helper expects a modal.
      const stopAutoAllow = startAutoAllow(page);

      await use(page);

      stopAutoAllow();
      await ctx.close();
    },
    { scope: "worker" },
  ],

  productFrame: [
    async ({ pairedPage }, use) => {
      const start = Date.now();
      const frame = await waitForHostPlaygroundFrame(
        pairedPage,
        PRODUCT_IFRAME_TIMEOUT_MS,
      );
      await waitForHostModalsSettled(pairedPage);
      console.log(`[productFrame] iframe ready in ${Date.now() - start}ms`);
      await use(frame);
    },
    // Test-scoped: dot.li replaces the product iframe when the page navigates
    // (a product handoff) or reloads the product, so a frame kept for the
    // whole worker would be detached for every test after that.
    // Its own timeout: a gateway download can exceed the 30 s test timeout
    // it would otherwise share.
    {
      scope: "test",
      timeout:
        PRODUCT_IFRAME_TIMEOUT_MS + HOST_MODAL_SETTLE_TIMEOUT_MS + 10_000,
    },
  ],
});

export { expect } from "@playwright/test";
