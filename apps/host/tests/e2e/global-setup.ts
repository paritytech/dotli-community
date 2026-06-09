// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { chromium, type FullConfig } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  pair,
  health,
  generateUsername,
  type PairResult,
} from "./helpers/signer-bot";
import { extractQrPayload } from "./helpers/extract-qr-payload";
import { STATE_FILE, SESSION_FILE } from "./fixtures/paths";

// External-service config. Required, with no defaults. A wrong or missing
// value silently breaks pairing (e.g. bot attesting on a different
// chain than the host listens on). Set in CI via the workflow env
// block and in local `.env`.
const SVC_TOKEN = requiredEnv("SIGNER_BOT_SVC_TOKEN");
const BOT_BASE = requiredEnv("SIGNER_BOT_BASE_URL");
// Must equal the host's default network (`packages/config/src/network.ts`
// `defaultNetwork()`, "paseo-next-v2" at time of writing). The bot's
// `/api/networks` lists supported IDs. A mismatch surfaces as "pair OK,
// user-badge never appears" because the chain-side handshake never
// reaches the host's protocol iframe.
const BOT_NETWORK = requiredEnv("SIGNER_BOT_NETWORK");
// Local-dev knobs. Defaults are fine because they don't depend on
// external services.
const PORT = process.env.PORT ?? "5173";
const HOST = process.env.E2E_HOST ?? "host-playground";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(
      `[globalSetup] ${name} not set. Required: see apps/host/tests/e2e/global-setup.ts and .github/workflows/test.yml.`,
    );
    process.exit(1);
  }
  return value;
}

const PAIR_ATTEMPTS = 3;
const PAIR_ATTEMPT_BACKOFF_MS = 3_000;
// One-time setup: the bot has to create the user and attest on the
// network, so the ceiling is more generous than the per-test restore.
// If this trips, the bot or chain is in trouble and the whole run
// should fail fast.
const USER_BADGE_TIMEOUT_MS = 60_000;

// Distinct exit code so CI workflow / reviewers can tell "Nova is down"
// apart from "dot.li tests asserted false". Keeps the failure attributable.
export const BOT_UNAVAILABLE_EXIT_CODE = 99;

export default async function globalSetup(_config: FullConfig): Promise<void> {
  console.log(`[globalSetup] bot=${BOT_BASE} network=${BOT_NETWORK}`);

  const probe = await health(BOT_BASE);
  if (!probe.ok) {
    console.error(
      `[globalSetup] BOT UNAVAILABLE: ${probe.error ?? probe.status ?? "unknown"} — skipping pair, exiting with code ${BOT_UNAVAILABLE_EXIT_CODE}.`,
    );
    console.error(
      `[globalSetup] This is a Nova-side outage signal, not a dot.li test failure.`,
    );
    process.exit(BOT_UNAVAILABLE_EXIT_CODE);
  }
  console.log(
    `[globalSetup] bot health ok (uptime=${probe.uptime ?? "?"}s) — pairing once.`,
  );

  // Honor HEADED=1 here too so a local repro can watch the pair flow.
  const browser = await chromium.launch({
    headless: process.env.HEADED !== "1",
    slowMo: process.env.SLOWMO ? Number(process.env.SLOWMO) : 0,
  });
  let lastErr: unknown = null;

  for (let attempt = 1; attempt <= PAIR_ATTEMPTS; attempt++) {
    try {
      const result = await pairOnce(browser);
      mkdirSync(dirname(STATE_FILE), { recursive: true });
      writeFileSync(
        SESSION_FILE,
        JSON.stringify(
          {
            sessionId: result.pairResult.sessionId,
            username: result.username,
            network: BOT_NETWORK,
            botBase: BOT_BASE,
          },
          null,
          2,
        ),
      );
      console.log(
        `[globalSetup] paired as "${result.username}" sessionId=${result.pairResult.sessionId.slice(0, 16)}… (attempt ${attempt}/${PAIR_ATTEMPTS})`,
      );
      await browser.close();
      return;
    } catch (e) {
      lastErr = e;
      console.warn(
        `[globalSetup] attempt ${attempt}/${PAIR_ATTEMPTS} failed: ${(e as Error).message}`,
      );
      if (attempt < PAIR_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, PAIR_ATTEMPT_BACKOFF_MS));
      }
    }
  }

  await browser.close();
  console.error(
    `[globalSetup] PAIR EXHAUSTED after ${PAIR_ATTEMPTS} attempts: ${(lastErr as Error).message}`,
  );
  process.exit(BOT_UNAVAILABLE_EXIT_CODE);
}

async function pairOnce(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
): Promise<{ pairResult: PairResult; username: string }> {
  const username = generateUsername();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  page.on("pageerror", (err) => {
    console.log(`[globalSetup:pageerror] ${err.message}`);
  });

  await page.addInitScript(() => {
    try {
      localStorage.setItem("dotli:mode", "gateway");
      localStorage.setItem("dotli:chain-backend", "rpc");
      localStorage.setItem("dotli:content-backend", "ipfs-gateway");
    } catch {
      /* ignore */
    }
  });

  try {
    await page.goto(`http://${HOST}.localhost:${PORT}/`, { timeout: 60_000 });
    await page
      .getByRole("button", { name: "Switch to Gateway" })
      .click({ timeout: 5_000 })
      .catch(() => {});

    const authBtn = page.locator("#auth-button");
    await authBtn.waitFor({ state: "visible", timeout: 30_000 });
    await authBtn.click();

    const qrCanvas = page.locator("#auth-modal-qr canvas");
    await qrCanvas.waitFor({ state: "visible", timeout: 30_000 });

    const deeplink = await extractQrPayload(page, "#auth-modal-qr canvas");
    const pairStart = Date.now();
    const pairResult = await pair(BOT_BASE, SVC_TOKEN, {
      handshake: deeplink,
      username,
      network: BOT_NETWORK,
    });
    console.log(
      `[globalSetup] bot /api/pair OK in ${Date.now() - pairStart}ms sessionId=${pairResult.sessionId.slice(0, 16)}… — waiting for host to surface user-badge.`,
    );

    await page
      .locator("#auth-button .user-badge")
      .waitFor({ state: "visible", timeout: USER_BADGE_TIMEOUT_MS });

    // Persist cookies and localStorage from every origin this context has
    // touched (including the cross-origin shared-auth iframe on `host.<root>`).
    // This is what lets worker fixtures skip the QR/pair flow entirely.
    await ctx.storageState({ path: STATE_FILE });
    return { pairResult, username };
  } finally {
    await ctx.close();
  }
}
