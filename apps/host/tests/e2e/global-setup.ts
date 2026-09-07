// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { chromium, type FullConfig, type Page } from "@playwright/test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import {
  formatSigningHostExit,
  signingHostVersion,
  startSigningHostPair,
  stopSigningHost,
  stopSigningHostPid,
  type SigningHostConfig,
  type SigningHostProcess,
} from "./helpers/signing-host-cli";
import { extractQrPayload } from "./helpers/extract-qr-payload";
import {
  E2E_CHAIN_BACKEND,
  initializeChainBackend,
} from "./helpers/chain-backend";
import {
  STATE_FILE,
  SESSION_FILE,
  SIGNING_HOST_STATE_DIR,
  type PersistedSession,
} from "./fixtures/paths";

// Must equal the host's default network (`packages/config/src/network.ts`
// `defaultNetwork()`, "paseo-next-v2" at time of writing). Required with no
// default: a mismatch surfaces as "pair OK, user-badge never appears"
// because the CLI attests on a different chain than the host listens on.
const NETWORK = requiredEnv("SIGNING_HOST_NETWORK");
// The truapi-host CLI from paritytech/host-rust-core, on PATH by default.
// `||` not `??` because the .env loader can hand us empty strings.
const SIGNING_HOST_BIN = process.env.SIGNING_HOST_BIN || "truapi-host";
const SIGNING_HOST_BASE_PATH =
  process.env.SIGNING_HOST_BASE_PATH || SIGNING_HOST_STATE_DIR;
// The product the tests exercise, mirroring fixtures/paired.ts. The CLI
// scopes wallet-level signing (signRaw) to this id.
const PRODUCT_ID =
  process.env.SIGNING_HOST_PRODUCT_ID ||
  (process.env.E2E_PRODUCT_URL === undefined
    ? `${process.env.E2E_HOST ?? "host-playground"}.dot`
    : new URL(process.env.E2E_PRODUCT_URL).host);
// Local-dev knobs. Defaults are fine because they don't depend on
// external services.
const PORT = process.env.PORT ?? "5173";
// Pairing only needs the host shell and protocol iframe. Loading the
// host-playground product here can open product permission modals before the
// auth button is clicked, so keep global auth setup on the bare host origin.
const AUTH_HOST = process.env.E2E_AUTH_HOST ?? "localhost";

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

function positiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;

  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    console.error(
      `[globalSetup] ${name} must be a positive integer, got "${raw}".`,
    );
    process.exit(1);
  }
  return value;
}

const PAIR_ATTEMPTS = 3;
const PAIR_ATTEMPT_BACKOFF_MS = 3_000;
// First-attempt ceiling: a cold signing-host state dir registers a lite
// username and waits for ring inclusion, which can take several minutes.
const USER_BADGE_TIMEOUT_MS = positiveIntegerEnv(
  "E2E_PAIR_BADGE_TIMEOUT_MS",
  600_000,
);
// Retries reuse the warmed state dir, so they get a far smaller ceiling.
// Caps the worst case under CI's 35-min job timeout so exit 99 stays
// reachable during an outage instead of the runner hard-killing the job.
const RETRY_BADGE_TIMEOUT_MS = positiveIntegerEnv(
  "E2E_RETRY_BADGE_TIMEOUT_MS",
  120_000,
);
// A CLI death this soon after spawn is a deterministic tooling failure:
// chain-side errors take multiple RPC round trips to surface.
const FAST_CLI_EXIT_MS = 5_000;
// clap usage errors (unknown flag on a new release) exit with code 2.
const CLI_USAGE_EXIT_CODE = 2;

// Distinct exit code so CI workflow / reviewers can tell "testnet or
// identity backend is down" apart from "dot.li tests asserted false".
export const SIGNING_UNAVAILABLE_EXIT_CODE = 99;

const signingHostConfig: SigningHostConfig = {
  binary: SIGNING_HOST_BIN,
  basePath: SIGNING_HOST_BASE_PATH,
  network: NETWORK,
  productId: PRODUCT_ID,
  // With an explicit mnemonic the CLI signs as that account directly and
  // rejects auto-account naming flags.
  liteUsernamePrefix: process.env.HOST_CLI_SIGNER_MNEMONIC?.trim()
    ? undefined
    : "dotlitest",
};

// Thrown when the CLI process dies before login; elapsedMs distinguishes
// instant deterministic failures from chain-side ones.
class SigningHostExitError extends Error {
  readonly elapsedMs: number;
  readonly exitCode: number | null;
  constructor(message: string, elapsedMs: number, exitCode: number | null) {
    super(message);
    this.elapsedMs = elapsedMs;
    this.exitCode = exitCode;
  }
}

export default async function globalSetup(
  _config: FullConfig,
): Promise<() => Promise<void>> {
  console.log(
    `[globalSetup] signing-host=${SIGNING_HOST_BIN} network=${NETWORK} backend=${E2E_CHAIN_BACKEND}`,
  );

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

  // Honor HEADED=1 here too so a local repro can watch the pair flow.
  const browser = await chromium.launch({
    headless: process.env.HEADED !== "1",
    slowMo: process.env.SLOWMO ? Number(process.env.SLOWMO) : 0,
  });
  let lastErr: unknown = null;

  for (let attempt = 1; attempt <= PAIR_ATTEMPTS; attempt++) {
    try {
      const badgeTimeoutMs =
        attempt === 1 ? USER_BADGE_TIMEOUT_MS : RETRY_BADGE_TIMEOUT_MS;
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
        `[globalSetup] paired as "${result.username}" signing-host pid=${session.pid} (attempt ${attempt}/${PAIR_ATTEMPTS})`,
      );
      await browser.close();
      // Playwright runs this closure as the global teardown. Clearing the
      // session file keeps the stale-kill path a crash-only affair.
      return async () => {
        await stopSigningHost(result.signingHost);
        rmSync(SESSION_FILE, { force: true });
        console.log(
          `[globalTeardown] stopped signing-host pid=${session.pid} ("${result.username}")`,
        );
      };
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
  // A usage error or instant death is deterministic; hard-fail so a broken
  // release can't soft-pass the suite forever as an "outage".
  const deterministic =
    lastErr instanceof SigningHostExitError &&
    (lastErr.exitCode === CLI_USAGE_EXIT_CODE ||
      lastErr.elapsedMs < FAST_CLI_EXIT_MS);
  process.exit(deterministic ? 1 : SIGNING_UNAVAILABLE_EXIT_CODE);
}

// A crashed prior run can leave its signing host alive and still holding the
// state dir lock. Wait for it to die before pairing, then clear the record.
async function killStaleSigningHost(): Promise<void> {
  if (!existsSync(SESSION_FILE)) return;
  try {
    const stale = JSON.parse(
      readFileSync(SESSION_FILE, "utf-8"),
    ) as PersistedSession;
    if (stale.pid > 0) {
      console.warn(
        `[globalSetup] stopping stale signing-host pid=${stale.pid}`,
      );
      await stopSigningHostPid(stale.pid);
    }
  } catch {
    // Unreadable session file: nothing identifiable to stop.
  }
  rmSync(SESSION_FILE, { force: true });
}

// Login-failure detail captured in the page; see the init script below.
interface LoginFailure {
  tag?: string;
  kind?: string;
  reason?: string;
}
type LoginFailureWindow = Window & { __e2eLoginFailed?: LoginFailure };

async function pairOnce(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  badgeTimeoutMs: number,
): Promise<{ signingHost: SigningHostProcess; username: string }> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  page.on("pageerror", (err) => {
    console.log(`[globalSetup:pageerror] ${err.message}`);
  });

  await page.addInitScript(initializeChainBackend, E2E_CHAIN_BACKEND);
  // Installed before the CLI spawns and re-installed on every navigation,
  // so a LoginFailed fired at any point is never missed.
  await page.addInitScript(() => {
    window.addEventListener("dotli:truapi-auth-state", (event: Event) => {
      const detail = (
        event as CustomEvent<
          { tag?: string; kind?: string; reason?: string } | undefined
        >
      ).detail;
      if (detail?.tag === "LoginFailed") {
        (window as LoginFailureWindow).__e2eLoginFailed = detail;
      }
    });
  });

  let signingHost: SigningHostProcess | null = null;
  try {
    // Seeding ?network= pins the host to the CLI's network, so the two
    // can't silently drift apart (the classic "badge never appears" hang).
    await page.goto(`http://${AUTH_HOST}:${PORT}/?network=${NETWORK}`, {
      timeout: 60_000,
    });
    if (E2E_CHAIN_BACKEND === "rpc-gateway") {
      await page
        .getByRole("button", { name: "Switch to Gateway" })
        .click({ timeout: 5_000 })
        .catch(() => {});
    }

    const authBtn = page.locator("#auth-button");
    await authBtn.waitFor({ state: "visible", timeout: 30_000 });
    await authBtn.click();

    const qrCanvas = page.locator("#auth-modal-qr canvas");
    await qrCanvas.waitFor({ state: "visible", timeout: 30_000 });

    const deeplink = await extractQrPayload(page, "#auth-modal-qr canvas");
    const pairStart = Date.now();
    signingHost = startSigningHostPair(signingHostConfig, deeplink);

    await waitForSignedIn(page, signingHost, badgeTimeoutMs, pairStart);
    console.log(`[globalSetup] signed in after ${Date.now() - pairStart}ms.`);

    const username = (
      await page
        .locator("#user-popover-username")
        .innerText({ timeout: 5_000 })
        .catch(() => "unknown")
    ).trim();

    // Persist cookies and localStorage from every origin this context has
    // touched (including the cross-origin shared-auth iframe on `host.<root>`).
    // This is what lets worker fixtures skip the QR/pair flow entirely.
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

// Signed in when the user badge renders. Racing the host's LoginFailed
// event and the CLI's exit turns a hang into a fast, attributable failure.
async function waitForSignedIn(
  page: Page,
  signingHost: SigningHostProcess,
  badgeTimeoutMs: number,
  spawnedAtMs: number,
): Promise<void> {
  const outcome = await Promise.race([
    page
      .locator("#auth-button .user-badge")
      .waitFor({ state: "visible", timeout: badgeTimeoutMs })
      .then(() => ({ tag: "signed-in" as const })),
    page
      .waitForFunction(
        () => (window as LoginFailureWindow).__e2eLoginFailed ?? null,
        undefined,
        { timeout: 0 },
      )
      .then(async (handle) => ({
        tag: "login-failed" as const,
        failure: await handle.jsonValue(),
      })),
    signingHost.completed.then((result) => ({
      tag: "signing-host-exit" as const,
      result,
    })),
  ]);
  if (outcome.tag === "signing-host-exit") {
    throw new SigningHostExitError(
      formatSigningHostExit(outcome.result, signingHost.output()),
      Date.now() - spawnedAtMs,
      outcome.result.code,
    );
  }
  if (outcome.tag === "login-failed") {
    throw new Error(
      `Login failed (${outcome.failure?.kind ?? "Other"}): ${outcome.failure?.reason ?? "unknown"}`,
    );
  }
}
