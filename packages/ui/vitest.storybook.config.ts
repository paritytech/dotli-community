// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/// <reference types="node" />

import { join } from 'node:path';
import { defineConfig } from 'vitest/config';
import { storybookTest } from '@storybook/addon-vitest/vitest-plugin';
import { playwright } from '@vitest/browser-playwright';

// Local only, never run through turbo, so it is not a turbo input.
// eslint-disable-next-line turbo/no-undeclared-env-vars
const vrt = process.env['VRT'] === '1';

// Stories as tests, in a real Chromium. The happy-dom unit tests keep
// vitest.config.ts, so `npm test` needs no browser.
export default defineConfig({
  plugins: [storybookTest({ configDir: join(import.meta.dirname, '.storybook') })],
  define: { 'import.meta.env.VITE_VRT': JSON.stringify(vrt ? '1' : '0') },
  test: {
    name: 'storybook',
    // The Settings baseline shows the page's host, so the port is part of it.
    // Pinned for screenshots only: a plain run can take any free port.
    ...(vrt ? { api: { port: 63315, strictPort: true } } : {}),
    setupFiles: [join(import.meta.dirname, '.storybook/vitest.setup.ts')],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: 'chromium' }],
      expect: {
        toMatchScreenshot: {
          // Machine-local baselines for refactor checks, never committed.
          resolveScreenshotPath: ({ root, testFileName, arg, ext }) => join(root, '.vrt', testFileName, `${arg}${ext}`),
          resolveDiffPath: ({ root, testFileName, arg, ext }) =>
            join(root, '.vrt', '__diff__', testFileName, `${arg}${ext}`),
          comparatorName: 'pixelmatch',
          comparatorOptions: { threshold: 0.1, allowedMismatchedPixelRatio: 0.001 },
        },
      },
    },
  },
});
