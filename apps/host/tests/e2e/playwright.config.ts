// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { defineConfig } from '@playwright/test';
import { existsSync, readFileSync, statSync } from 'node:fs';
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

// A dist older than the lockfile is stale, and its failures look like obscure SDK bugs. CI always builds fresh.
if (process.env['CI'] !== 'true') {
  try {
    const lockMtime = statSync(resolve(repoRoot, 'package-lock.json')).mtimeMs;
    for (const app of ['host', 'sandbox', 'protocol']) {
      const distIndex = resolve(repoRoot, `apps/${app}/dist/index.html`);
      const distMtime = statSync(distIndex).mtimeMs;
      if (distMtime < lockMtime) {
        throw new Error(
          `apps/${app}/dist is older than package-lock.json — run \`npm run build\` from the repo root before re-running e2e.`,
        );
      }
    }
  } catch (e) {
    if (e instanceof Error && e.message.includes('ENOENT')) {
      throw new Error('dist directories missing — run `npm run build` from the repo root before running e2e.', {
        cause: e,
      });
    }
    throw e;
  }
}

const dotliWebServer = {
  command: 'node ../../../../scripts/preview-server.ts',
  url: `http://localhost:${process.env['PORT'] ?? '5173'}`,
  reuseExistingServer: true,
  timeout: 30_000,
};

const webServer: (typeof dotliWebServer & {
  cwd?: string;
  env?: Record<string, string>;
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
    // The embedded product must use dotli, not the playground's standalone CLI dev bridge.
    env: { NEXT_PUBLIC_SKIP_HOST_BRIDGE: '1' },
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
