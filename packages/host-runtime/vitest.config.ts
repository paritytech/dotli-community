// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: {
    // getEnabledNetworks() requires VITE_NETWORKS and has no default by design.
    'import.meta.env.VITE_NETWORKS': '"paseo-next-v2,previewnet"',
    // On, so a test reads what the page reports through a bound fake Sentry.
    'import.meta.env.VITE_METRICS': '"true"',
  },
  // `npm run link:truapi` points @parity/truapi-provider outside the workspace, and Vite's strict file serving would
  // refuse its `?url` wasm import.
  server: { fs: { strict: false } },
  test: {
    globals: false,
    projects: [
      {
        extends: true,
        test: {
          name: 'host-runtime:unit',
          include: ['src/**/*.spec.ts'],
          environment: 'node',
          setupFiles: ['src/testing/metrics-setup.ts', 'src/testing/mode-storage-setup.ts'],
        },
      },
    ],
  },
});
