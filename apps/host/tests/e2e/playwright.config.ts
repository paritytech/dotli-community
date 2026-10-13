// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { defineConfig } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { baseConfig } from '../playwright.base.config.js';

const repoRoot = resolve(import.meta.dirname, '../../../..');

// Playwright runs from apps/host, so it never sees the repo-root .env.
try {
  const env = readFileSync(resolve(repoRoot, '.env'), 'utf-8');
  for (const line of env.split('\n')) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) {
      continue;
    }
    const [, key, raw] = m;
    if (key === undefined || raw === undefined) {
      continue;
    }
    if ((process.env[key] ?? '') !== '') {
      continue;
    }
    process.env[key] = raw.replace(/^['"]|['"]$/g, '');
  }
  // eslint-disable-next-line no-restricted-syntax -- no .env is the normal CI case: the env must already be set.
} catch {
  /* no .env, env must already be set */
}

const localProductUrl = process.env['E2E_PRODUCT_URL'];

const dotliWebServer = {
  command: 'node ../../../../scripts/preview-server.ts',
  url: `http://localhost:${process.env['PORT'] ?? '5173'}`,
  reuseExistingServer: true,
  timeout: 30_000,
};

const webServer: (typeof dotliWebServer & {
  cwd?: string;
})[] = [dotliWebServer];
if (localProductUrl !== undefined) {
  const productUrl = new URL(localProductUrl);
  if (productUrl.protocol !== 'http:' || (productUrl.hostname !== 'localhost' && productUrl.hostname !== '127.0.0.1')) {
    throw new Error(`E2E_PRODUCT_URL must be a loopback HTTP URL, got ${localProductUrl}`);
  }
  const hostPlaygroundRoot = resolve(process.env['E2E_PRODUCT_REPO'] ?? resolve(repoRoot, '../../../host-playground'));
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
