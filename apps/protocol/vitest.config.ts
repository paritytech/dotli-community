// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Real-browser storage tests run through vitest.browser.config.ts.
    exclude: [...configDefaults.exclude, 'tests/browser/**'],
    environment: 'happy-dom',
    globals: false,
  },
  define: {
    'import.meta.env.DEV': 'false',
    'import.meta.env.VITE_APP_DEBUG': '"true"',
    // getEnabledNetworks() has no default, so tests supply VITE_NETWORKS like a deployment does.
    'import.meta.env.VITE_NETWORKS': '"paseo-next-v2,previewnet"',
  },
});
