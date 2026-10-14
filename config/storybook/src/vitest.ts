// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/// <reference types="node" />

import { join } from 'node:path';
import { defineConfig, type ViteUserConfig } from 'vitest/config';
import { storybookTest } from '@storybook/addon-vitest/vitest-plugin';
import { playwright } from '@vitest/browser-playwright';

// Local only, never run through turbo, so it is not a turbo input.
// eslint-disable-next-line turbo/no-undeclared-env-vars
const vrt = process.env['VRT'] === '1';

/**
 * The browser test config for the stories of the package at `packageDir`, whose `.storybook` holds its Storybook.
 * Stories run in a real Chromium, apart from the package's vitest.config.ts so `npm test` needs no browser.
 */
export function storybookVitestConfig(packageDir: string): ViteUserConfig {
  return defineConfig({
    plugins: [storybookTest({ configDir: join(packageDir, '.storybook') })],
    define: { 'import.meta.env.VITE_VRT': JSON.stringify(vrt ? '1' : '0') },
    test: {
      name: 'storybook',
      api: {
        // The Storybook plugin turns these off unless they are set. A tap goes through the DevTools protocol, which
        // needs both, and the server listens on localhost only.
        allowWrite: true,
        allowExec: true,
        // A story that shows the page's host would differ run to run, so screenshot runs pin the port.
        ...(vrt ? { port: 63315, strictPort: true } : {}),
      },
      setupFiles: [join(import.meta.dirname, 'vitest.setup.ts')],
      browser: {
        enabled: true,
        headless: true,
        provider: playwright(),
        instances: [{ browser: 'chromium' }],
        expect: {
          toMatchScreenshot: {
            // Machine-local baselines for refactor checks, never committed.
            resolveScreenshotPath: ({ root, testFileName, arg, ext }) =>
              join(root, '.vrt', testFileName, `${arg}${ext}`),
            resolveDiffPath: ({ root, testFileName, arg, ext }) =>
              join(root, '.vrt', '__diff__', testFileName, `${arg}${ext}`),
            comparatorName: 'pixelmatch',
            comparatorOptions: { threshold: 0.1, allowedMismatchedPixelRatio: 0.001 },
          },
        },
      },
    },
  });
}
