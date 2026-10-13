// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { defineConfig } from 'vitest/config';
import { TEST_DEFINES } from '@config/vite/test-defines';

export default defineConfig({
  // `npm run link:truapi` points @parity/truapi-provider at a checkout outside
  // this workspace, and its `?url` wasm import would be refused by Vite's
  // workspace-only file serving.
  server: { fs: { strict: false } },
  test: {
    globals: false,
    setupFiles: ['@dotli/metrics/testing/setup'],
    projects: [{ extends: true, test: { name: 'chains:unit', include: ['src/**/*.spec.ts'], environment: 'node' } }],
  },
  define: {
    ...TEST_DEFINES,
    'import.meta.env.DEV': 'false',
    'import.meta.env.VITE_APP_DEBUG': '"true"',
    // On, so a test reads what the chains report through a bound fake Sentry.
    'import.meta.env.VITE_METRICS': '"true"',
  },
});
