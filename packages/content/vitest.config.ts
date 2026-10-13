// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    projects: [{ extends: true, test: { name: 'content:unit', include: ['src/**/*.spec.ts'], environment: 'node' } }],
  },
  define: {
    'import.meta.env.DEV': 'false',
    'import.meta.env.VITE_APP_DEBUG': '"true"',
    // On, so a test reads what the page reports through a bound fake Sentry.
    'import.meta.env.VITE_METRICS': '"true"',
    // Required, with no default.
    'import.meta.env.VITE_NETWORKS': '"paseo-next-v2,previewnet"',
  },
});
