// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { defineConfig } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { baseConfig, previewServer } from '../playwright.base.config.js';

const repoRoot = resolve(import.meta.dirname, '../../../..');

// Playwright runs from apps/host, so it never sees the repo-root .env. A value the shell set wins.
const envFile = resolve(repoRoot, '.env');
if (existsSync(envFile)) {
  for (const [key, value] of Object.entries(parseEnv(readFileSync(envFile, 'utf-8')))) {
    if (value !== undefined && (process.env[key] ?? '') === '') {
      process.env[key] = value;
    }
  }
}

const localProductUrl = process.env['E2E_PRODUCT_URL'];

const dotliWebServer = { ...previewServer, url: `http://localhost:${process.env['PORT'] ?? '5173'}` };

const webServer: (typeof dotliWebServer & {
  cwd?: string;
})[] = [dotliWebServer];
if (localProductUrl !== undefined) {
  const productUrl = new URL(localProductUrl);
  if (productUrl.protocol !== 'http:' || (productUrl.hostname !== 'localhost' && productUrl.hostname !== '127.0.0.1')) {
    throw new Error(`E2E_PRODUCT_URL must be a loopback HTTP URL, got ${localProductUrl}`);
  }
  // Beside this checkout, unless set. A relative path is read from the repo root, as the link scripts read it.
  const hostPlaygroundRoot = resolve(repoRoot, process.env['E2E_PRODUCT_REPO'] ?? '../host-playground');
  if (!existsSync(resolve(hostPlaygroundRoot, 'package.json'))) {
    throw new Error(
      `host-playground checkout not found at ${hostPlaygroundRoot}. Set E2E_PRODUCT_REPO=/path/to/host-playground.`,
    );
  }
  webServer.unshift({
    command: `yarn dev --port ${productUrl.port || '80'}`,
    cwd: hostPlaygroundRoot,
    url: productUrl.origin,
    reuseExistingServer: true,
    timeout: 30_000,
  });
}

export default defineConfig({
  ...baseConfig,
  webServer,
  testDir: '.',
  // Beside results.json, since the CI upload step doesn't cover the default packageJsonDir/test-results.
  outputDir: 'test-results',
  timeout: 60_000,
  retries: 1,
  workers: 1,
  globalTimeout: 30 * 60_000,
  // globalSetup returns the teardown closure that stops the signing host.
  globalSetup: './global-setup.ts',
  use: {
    ...baseConfig.use,
    trace: 'retain-on-failure',
    video: 'off',
  },
  reporter: [['list'], ['json', { outputFile: 'test-results/results.json' }]],
});
