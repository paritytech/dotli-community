// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { defineConfig } from "@playwright/test";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { baseConfig } from "../playwright.base.config";

const repoRoot = resolve(import.meta.dirname, "../../../..");

// Load repo-root .env (bun's autoload only picks the cwd one).
try {
  const env = readFileSync(resolve(repoRoot, ".env"), "utf-8");
  for (const line of env.split("\n")) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, key, raw] = m;
    if (process.env[key]) continue;
    process.env[key] = raw.replace(/^['"]|['"]$/g, "");
  }
} catch {
  /* no .env, env must already be set */
}

// Stale-dist guard. The preview server serves built artifacts from
// `apps/{host,sandbox,protocol}/dist`. If those are older than the lockfile
// we're almost certainly running against an out-of-date build. The symptoms
// look like obscure SDK byte-parity bugs but the fix is `bun run build`. CI
// is unaffected because it always builds fresh. This only fires for local
// repeat runs.
if (process.env.CI !== "true") {
  try {
    const lockMtime = statSync(resolve(repoRoot, "bun.lock")).mtimeMs;
    for (const app of ["host", "sandbox", "protocol"]) {
      const distIndex = resolve(repoRoot, `apps/${app}/dist/index.html`);
      const distMtime = statSync(distIndex).mtimeMs;
      if (distMtime < lockMtime) {
        throw new Error(
          `apps/${app}/dist is older than bun.lock — run \`bun run build\` from the repo root before re-running e2e.`,
        );
      }
    }
  } catch (e) {
    if (e instanceof Error && e.message.includes("ENOENT")) {
      throw new Error(
        "dist directories missing — run `bun run build` from the repo root before running e2e.",
      );
    }
    throw e;
  }
}

export default defineConfig({
  ...baseConfig,
  testDir: ".",
  timeout: 60_000,
  retries: 1,
  workers: 1,
  globalTimeout: 30 * 60_000,
  globalSetup: "./global-setup.ts",
  globalTeardown: "./global-teardown.ts",
  use: {
    ...baseConfig.use,
    trace: "retain-on-failure",
    video: "off",
  },
  reporter: [["list"], ["json", { outputFile: "test-results/results.json" }]],
});
