// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { defineConfig } from "@playwright/test";
import { baseConfig } from "../playwright.base.config";

const PORT = process.env.PERF_PORT ?? "5173";

export default defineConfig({
  ...baseConfig,
  testDir: ".",
  timeout: 900_000,
  retries: 0,
  use: {
    ...baseConfig.use,
    baseURL: `http://browse.localhost:${PORT}`,
  },
  webServer: {
    command: `PORT=${PORT} bun ../../../../scripts/preview-server.ts`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
  reporter: [["list"]],
});
