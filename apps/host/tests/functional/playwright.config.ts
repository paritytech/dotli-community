// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { defineConfig } from '@playwright/test';
import { baseConfig, previewServer } from '../playwright.base.config.js';

// One by default: every cold load downloads a ~14 MB CAR from an uncached gateway, so parallel workers only
// contend for it. Raise once paritytech/devops#5734 is fixed.
const WORKERS = Number(process.env['FUNCTIONAL_WORKERS'] ?? '1');

export default defineConfig({
  ...baseConfig,
  testDir: '.',
  timeout: 900_000,
  retries: 0,
  // One preview server per worker: its metrics buffer and mode-sync store are process-wide, and tests must not
  // share them.
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
