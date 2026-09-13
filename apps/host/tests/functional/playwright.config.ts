// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { defineConfig } from "@playwright/test";
import { baseConfig } from "../playwright.base.config";

export default defineConfig({
  ...baseConfig,
  testDir: ".",
  timeout: 900_000,
  retries: 0,
  // One worker, because `network-transport.spec.ts` counts `smoldot.active`
  // points out of a single buffer on the preview server, and nothing on a
  // point identifies the test that produced it. Run in parallel, the shared
  // smoldot case in `loading.spec.ts` emits an identical `shared-worker`
  // point and gets counted as a second light client.
  workers: 1,
  use: {
    ...baseConfig.use,
    baseURL: "http://browse.localhost:5173",
  },
  reporter: [["list"], ["json", { outputFile: "results.json" }]],
});
