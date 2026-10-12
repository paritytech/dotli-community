// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';

// Storage that fake-indexeddb cannot model (Blobs, structured clone) runs in a real Chromium, apart from
// vitest.config.ts so `npm test` needs no browser.
export default defineConfig({
  test: {
    name: 'protocol-browser',
    include: ['tests/browser/**/*.test.ts'],
    globals: false,
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: 'chromium' }],
    },
  },
  define: {
    'import.meta.env.DEV': 'false',
    'import.meta.env.VITE_APP_DEBUG': '"true"',
    'import.meta.env.VITE_NETWORKS': '"paseo-next-v2,previewnet"',
  },
});
