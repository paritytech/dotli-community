// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { chromium, type FullConfig, type Page } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  formatSigningHostExit,
  signingHostVersion,
  startSigningHostPair,
  stopSigningHost,
  stopSigningHostPid,
  type SigningHostConfig,
  type SigningHostProcess,
} from './helpers/signing-host-cli.js';
import { extractQrPayload } from './helpers/extract-qr-payload.js';
import { E2E_CHAIN_BACKEND, initializeChainBackend } from './helpers/chain-backend.js';
import { STATE_FILE, SESSION_FILE, SIGNING_HOST_STATE_DIR, type PersistedSession } from './fixtures/paths.js';

// Must equal the host's default network, or pairing succeeds but the badge never appears: the CLI attests on another
// chain.
const NETWORK = requiredEnv('SIGNING_HOST_NETWORK');
// The .env loader can hand us empty strings, so these treat "" as unset.
const SIGNING_HOST_BIN = nonEmptyEnv('SIGNING_HOST_BIN') ?? 'truapi-host';
const SIGNING_HOST_BASE_PATH = nonEmptyEnv('SIGNING_HOST_BASE_PATH') ?? SIGNING_HOST_STATE_DIR;
// Mirrors fixtures/paired.ts. The CLI scopes wallet-level signing to this id.
const PRODUCT_ID =
  nonEmptyEnv('SIGNING_HOST_PRODUCT_ID') ??
  (process.env['E2E_PRODUCT_URL'] === undefined
    ? `${process.env['E2E_HOST'] ?? 'host-playground'}.dot`
    : new URL(process.env['E2E_PRODUCT_URL']).host);
const PORT = process.env['PORT'] ?? '5173';
// The bare host origin, since loading the product can open its permission modals before the auth button is clicked.
const AUTH_HOST = process.env['E2E_AUTH_HOST'] ?? 'localhost';

function nonEmptyEnv(name: string): string | undefined {
  const value = process.env[name];
  return value === '' ? undefined : value;
}

function requiredEnv(name: string): string {
  const value = nonEmptyEnv(name);
  if (value === undefined) {
    console.error(
      `[globalSetup] ${name} not set. Required: see apps/host/tests/e2e/global-setup.ts and .github/workflows/test.yml.`,
    );
    process.exit(1);
  }
  return value;
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    console.error(`[globalSetup] ${name} must be a positive integer, got "${raw}".`);
    process.exit(1);
  }
  return value;
}

const PAIR_ATTEMPTS = 3;
const PAIR_ATTEMPT_BACKOFF_MS = 3_000;
// A cold state dir registers a lite username and waits for ring inclusion, which can take minutes.
const USER_BADGE_TIMEOUT_MS = positiveIntegerEnv('E2E_PAIR_BADGE_TIMEOUT_MS', 600_000);
// Retries reuse the warmed state dir. Keeps the worst case under CI's 35-min job timeout, so exit 99 stays reachable.
const RETRY_BADGE_TIMEOUT_MS = positiveIntegerEnv('E2E_RETRY_BADGE_TIMEOUT_MS', 120_000);
// A CLI death this soon after spawn is a deterministic tooling failure:
// chain-side errors take multiple RPC round trips to surface.
const FAST_CLI_EXIT_MS = 5_000;
// clap usage errors (unknown flag on a new release) exit with code 2.
const CLI_USAGE_EXIT_CODE = 2;

// Lets CI tell a testnet or identity backend outage from a failed assertion.
export const SIGNING_UNAVAILABLE_EXIT_CODE = 99;

// A username can be claimed only once, so a fixed base fails on every later run. The CLI rejects digits and
// separators.
function randomSessionBase(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz';
  let suffix = '';
  for (let i = 0; i < 6; i++) {
    suffix += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return `dotlitest${suffix}`;
}

// Per attempt: a failed attempt can leave its name claimed, and a retry must not ask for it again.
function signingHostConfig(): SigningHostConfig {
  return {
    binary: SIGNING_HOST_BIN,
    basePath: SIGNING_HOST_BASE_PATH,
    network: NETWORK,
    productId: PRODUCT_ID,
    // With an explicit mnemonic the CLI signs as that account directly and
    // rejects auto-account naming flags.
    session: (process.env['HOST_CLI_SIGNER_MNEMONIC']?.trim() ?? '') !== '' ? undefined : randomSessionBase(),
  };
}

// elapsedMs tells an instant deterministic failure from a chain-side one.
class SigningHostExitError extends Error {
  readonly elapsedMs: number;
  readonly exitCode: number | null;
  constructor(message: string, elapsedMs: number, exitCode: number | null) {
    super(message);
    this.elapsedMs = elapsedMs;
    this.exitCode = exitCode;
  }
}

// A dist older than the lockfile is stale, and its failures look like obscure SDK bugs. CI always builds fresh. Checked
// here rather than in the config, which tools such as knip load without running the tests.
function assertFreshDist(): void {
  if (process.env['CI'] === 'true') {
    return;
  }
  const repoRoot = resolve(import.meta.dirname, '../../../..');
  try {
    const lockMtime = statSync(resolve(repoRoot, 'package-lock.json')).mtimeMs;
    for (const app of ['host', 'sandbox', 'protocol']) {
      const distIndex = resolve(repoRoot, `apps/${app}/dist/index.html`);
      const distMtime = statSync(distIndex).mtimeMs;
      if (distMtime < lockMtime) {
        throw new Error(
          `apps/${app}/dist is older than package-lock.json — run \`npm run build\` from the repo root before re-running e2e.`,
        );
      }
    }
  } catch (e) {
    if (e instanceof Error && e.message.includes('ENOENT')) {
      throw new Error('dist directories missing — run `npm run build` from the repo root before running e2e.', {
        cause: e,
      });
    }
    throw e;
  }
}

export default async function globalSetup(_config: FullConfig): Promise<() => Promise<void>> {
  assertFreshDist();
  console.log(`[globalSetup] signing-host=${SIGNING_HOST_BIN} network=${NETWORK} backend=${E2E_CHAIN_BACKEND}`);

  const version = signingHostVersion(SIGNING_HOST_BIN);
  if (version === null) {
    console.error(
      `[globalSetup] truapi-host CLI not runnable at "${SIGNING_HOST_BIN}". ` +
        `Install it (see README "Running the host-playground E2E locally") ` +
        `or point SIGNING_HOST_BIN at a built binary.`,
    );
    process.exit(1);
  }
  console.log(`[globalSetup] signing-host version: ${version} — pairing once.`);

  await killStaleSigningHost();

  const browser = await chromium.launch({
    headless: process.env['HEADED'] !== '1',
    slowMo: process.env['SLOWMO'] !== undefined && process.env['SLOWMO'] !== '' ? Number(process.env['SLOWMO']) : 0,
  });
  let lastErr: unknown = null;

  for (let attempt = 1; attempt <= PAIR_ATTEMPTS; attempt++) {
    try {
      const badgeTimeoutMs = attempt === 1 ? USER_BADGE_TIMEOUT_MS : RETRY_BADGE_TIMEOUT_MS;
      const result = await pairOnce(browser, badgeTimeoutMs);
      mkdirSync(dirname(STATE_FILE), { recursive: true });
      const session: PersistedSession = {
        pid: result.signingHost.child.pid ?? -1,
        username: result.username,
        network: NETWORK,
        basePath: SIGNING_HOST_BASE_PATH,
      };
      writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2));
      console.log(
        `[globalSetup] paired as "${result.username}" signing-host pid=${String(session.pid)} (attempt ${String(attempt)}/${String(PAIR_ATTEMPTS)})`,
      );
      await browser.close();
      // The global teardown. Clearing the session file leaves the stale-kill path to crashes only.
      return async () => {
        await stopSigningHost(result.signingHost);
        rmSync(SESSION_FILE, { force: true });
        console.log(`[globalTeardown] stopped signing-host pid=${String(session.pid)} ("${result.username}")`);
      };
    } catch (e) {
      lastErr = e;
      console.warn(`[globalSetup] attempt ${String(attempt)}/${String(PAIR_ATTEMPTS)} failed: ${(e as Error).message}`);
      if (attempt < PAIR_ATTEMPTS) {
        await new Promise(r => setTimeout(r, PAIR_ATTEMPT_BACKOFF_MS));
      }
    }
  }

  await browser.close();
  console.error(`[globalSetup] PAIR EXHAUSTED after ${String(PAIR_ATTEMPTS)} attempts: ${(lastErr as Error).message}`);
  // A usage error or instant death is deterministic, so a broken release hard-fails rather than passing as an outage.
  const deterministic =
    lastErr instanceof SigningHostExitError &&
    (lastErr.exitCode === CLI_USAGE_EXIT_CODE || lastErr.elapsedMs < FAST_CLI_EXIT_MS);
  process.exit(deterministic ? 1 : SIGNING_UNAVAILABLE_EXIT_CODE);
}

// A crashed prior run can leave its signing host alive and still holding the
// state dir lock. Wait for it to die before pairing, then clear the record.
async function killStaleSigningHost(): Promise<void> {
  if (!existsSync(SESSION_FILE)) {
    return;
  }
  try {
    const stale = JSON.parse(readFileSync(SESSION_FILE, 'utf-8')) as PersistedSession;
    if (stale.pid > 0) {
      console.warn(`[globalSetup] stopping stale signing-host pid=${String(stale.pid)}`);
      await stopSigningHostPid(stale.pid);
    }
    // eslint-disable-next-line no-restricted-syntax -- an unreadable session file names no process to stop, so there is nothing to report.
  } catch {
    // Unreadable session file: nothing identifiable to stop.
  }
  rmSync(SESSION_FILE, { force: true });
}

async function pairOnce(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  badgeTimeoutMs: number,
): Promise<{ signingHost: SigningHostProcess; username: string }> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  page.on('pageerror', err => {
    console.log(`[globalSetup:pageerror] ${err.message}`);
  });

  await page.addInitScript(initializeChainBackend, E2E_CHAIN_BACKEND);

  let signingHost: SigningHostProcess | null = null;
  try {
    // Pins the host to the CLI's network, so the two cannot drift apart.
    await page.goto(`http://${AUTH_HOST}:${PORT}/?network=${NETWORK}`, {
      timeout: 60_000,
    });

    // The button is in the built page, so it is visible before its island hydrates.
    const authBtn = page.locator('#landing-auth-button');
    await page.waitForFunction(() => document.querySelectorAll('astro-island[ssr]').length === 0, undefined, {
      timeout: 30_000,
    });
    await authBtn.click();

    const qrCanvas = page.locator('#auth-modal-qr canvas');
    await qrCanvas.waitFor({ state: 'visible', timeout: 30_000 });

    const deeplink = await extractQrPayload(page, '#auth-modal-qr canvas');
    const pairStart = Date.now();
    signingHost = startSigningHostPair(signingHostConfig(), deeplink);

    await waitForSignedIn(page, signingHost, badgeTimeoutMs, pairStart);
    console.log(`[globalSetup] signed in after ${String(Date.now() - pairStart)}ms.`);

    const username = (
      await page
        .locator('#landing-user-popover-username')
        .innerText({ timeout: 5_000 })
        .catch(() => 'unknown')
    ).trim();

    // Includes the cross-origin shared-auth iframe's storage, which lets worker fixtures skip pairing.
    await ctx.storageState({ path: STATE_FILE });
    const paired = signingHost;
    signingHost = null;
    return { signingHost: paired, username };
  } finally {
    // Only on failure: the successful path hands the process to teardown.
    if (signingHost !== null) {
      await stopSigningHost(signingHost);
    }
    await ctx.close();
  }
}

// Signed in when the user badge renders. Racing the sign-in modal's failure
// view and the CLI's exit turns a hang into a fast, attributable failure.
async function waitForSignedIn(
  page: Page,
  signingHost: SigningHostProcess,
  badgeTimeoutMs: number,
  spawnedAtMs: number,
): Promise<void> {
  const outcome = await Promise.race([
    page
      .locator('#landing-auth-button')
      .getByTestId('user-badge')
      .waitFor({ state: 'visible', timeout: badgeTimeoutMs })
      .then(() => ({ tag: 'signed-in' as const })),
    page
      .getByTestId('auth-modal-failure')
      .waitFor({ state: 'visible', timeout: 0 })
      .then(async () => ({
        tag: 'login-failed' as const,
        failure: await page.getByTestId('auth-modal-failure').innerText(),
      })),
    signingHost.completed.then(result => ({
      tag: 'signing-host-exit' as const,
      result,
    })),
  ]);
  if (outcome.tag === 'signing-host-exit') {
    throw new SigningHostExitError(
      formatSigningHostExit(outcome.result, signingHost.output()),
      Date.now() - spawnedAtMs,
      outcome.result.code,
    );
  }
  if (outcome.tag === 'login-failed') {
    // The modal's title, explanation and, unless the copy hides it, the raw reason.
    throw new Error(`Login failed: ${outcome.failure.replace(/\s+/g, ' ').trim()}`);
  }
}
