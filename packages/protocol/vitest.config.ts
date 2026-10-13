// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    projects: [{ extends: true, test: { name: 'protocol:unit', include: ['src/**/*.spec.ts'], environment: 'node' } }],
  },
  define: {
    'import.meta.env.DEV': 'false',
    'import.meta.env.VITE_APP_DEBUG': '"false"',
    'import.meta.env.VITE_METRICS': '"true"',
    // getEnabledNetworks() has no default, so the test build supplies networks like a deployment does.
    'import.meta.env.VITE_NETWORKS': '"paseo-next-v2,previewnet"',
  },
});
