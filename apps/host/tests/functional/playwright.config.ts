// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { defineConfig } from '@playwright/test';
import { baseConfig, previewServer } from '../playwright.base.config.js';

// Published-product tests share remote RPC and gateway services. Keep one
// worker by default; opt into parallel runs with FUNCTIONAL_WORKERS.
const WORKERS = Number(process.env['FUNCTIONAL_WORKERS'] ?? '1');

export default defineConfig({
  ...baseConfig,
  testDir: '.',
  timeout: 900_000,
  retries: 0,
  use: {
    ...baseConfig.use,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  outputDir: './test-results',
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
  reporter: [['list'], ['json', { outputFile: 'results.json' }]],
});
