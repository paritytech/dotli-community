// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/// <reference types="node" />

import { join } from 'node:path';
import { defineConfig } from 'vitest/config';
import { storybookTest } from '@storybook/addon-vitest/vitest-plugin';
import { playwright } from '@vitest/browser-playwright';

// Stories as tests, in a real Chromium. The happy-dom unit tests keep
// vitest.config.ts, so `npm test` needs no browser.
export default defineConfig({
  plugins: [storybookTest({ configDir: join(import.meta.dirname, '.storybook') })],
  test: {
    name: 'storybook',
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: 'chromium' }],
    },
  },
});
