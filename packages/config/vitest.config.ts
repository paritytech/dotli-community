// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    projects: [{ extends: true, test: { name: 'config:unit', include: ['src/**/*.spec.ts'], environment: 'node' } }],
  },
  define: {
    'import.meta.env.DEV': 'false',
    'import.meta.env.VITE_APP_DEBUG': '"true"',
    // getEnabledNetworks() requires VITE_NETWORKS, with no default by design.
    'import.meta.env.VITE_NETWORKS': '"paseo-next-v2,previewnet"',
  },
});
