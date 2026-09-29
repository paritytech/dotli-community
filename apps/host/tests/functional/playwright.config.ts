// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { defineConfig } from "@playwright/test";
import { baseConfig, previewServer } from "../playwright.base.config";

// Capped by the IPFS gateway, not CPU: every cold load downloads
// host-playground's ~14 MB CAR from paseo-bulletin-next-ipfs, and parallel
// downloads share its throughput. At 4 workers some of them failed outright
// ("couldn't connect to the trusted provider"); 2 stayed green.
// FUNCTIONAL_WORKERS=1 reproduces the serial run.
const WORKERS = Number(process.env.FUNCTIONAL_WORKERS ?? "2");

export default defineConfig({
  ...baseConfig,
  testDir: ".",
  timeout: 900_000,
  retries: 0,
  // Each worker gets its own preview server (`PORT` in ../env.ts picks it by
  // TEST_PARALLEL_INDEX). The server holds process-wide state that tests must
  // not share: `network-transport.spec.ts` counts `smoldot.active` points out
  // of its metrics buffer, where nothing identifies the test that produced a
  // point, and every test wipes and reseeds its mode-sync store.
  workers: WORKERS,
  fullyParallel: true,
  webServer: Array.from({ length: WORKERS }, (_, i) => {
    const port = String(5173 + i);
    return {
      ...previewServer,
      url: `http://localhost:${port}`,
      env: { PORT: port },
    };
  }),
  use: baseConfig.use,
  reporter: [["list"], ["json", { outputFile: "results.json" }]],
});
