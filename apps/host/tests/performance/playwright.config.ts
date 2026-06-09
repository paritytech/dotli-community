// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { defineConfig } from "@playwright/test";
import { baseConfig } from "../playwright.base.config";

export default defineConfig({
  ...baseConfig,
  testDir: ".",
  timeout: 900_000,
  retries: 0,
  use: {
    ...baseConfig.use,
    baseURL: "http://browse.localhost:5173",
  },
  reporter: [["list"]],
});
