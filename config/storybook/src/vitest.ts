// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/// <reference types="node" />

import { join } from 'node:path';
import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';

// eslint-disable-next-line turbo/no-undeclared-env-vars -- local only, never run through turbo, so not a turbo input.
const vrt = process.env['VRT'] === '1';

/**
 * How stories run as tests in a real Chromium, apart from the unit test configs so `npm test` needs no browser. The
 * Vitest config of the Storybook adds the Storybook plugin that turns each story into a test.
 */
export const storiesBrowserTest = defineConfig({
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
          // Machine-local baselines for refactor checks, never committed. Keyed on the story file's path, since
          // story files in different packages may share a name.
          resolveScreenshotPath: ({ root, testFileDirectory, testFileName, arg, ext }) =>
            join(root, '.vrt', testFileDirectory, testFileName, `${arg}${ext}`),
          resolveDiffPath: ({ root, testFileDirectory, testFileName, arg, ext }) =>
            join(root, '.vrt', '__diff__', testFileDirectory, testFileName, `${arg}${ext}`),
          comparatorName: 'pixelmatch',
          comparatorOptions: { threshold: 0.1, allowedMismatchedPixelRatio: 0.001 },
        },
      },
    },
  },
});
