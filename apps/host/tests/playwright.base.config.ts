// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared Playwright settings for every host test suite.
 *
 * Each suite (functional, e2e, performance) extends this via
 * `defineConfig({ ...base, ... })` and overrides `testDir`, `reporter`,
 * timeouts, and globalSetup as needed.
 */

import type { PlaywrightTestConfig } from "@playwright/test";

const PORT = "5173";

export const baseConfig: PlaywrightTestConfig = {
  use: {
    browserName: "chromium",
    channel: process.env.CHANNEL,
    headless: process.env.HEADED !== "1",
    bypassCSP: true,
    launchOptions: {
      slowMo: process.env.SLOWMO ? Number(process.env.SLOWMO) : 0,
    },
  },
  webServer: {
    command: "bun ../../../../scripts/preview-server.ts",
    url: `http://localhost:${PORT}`,
    reuseExistingServer: true,
    timeout: 30_000,
  },
};
