// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { defineConfig } from 'vitest/config';
import { TEST_DEFINES } from '@config/vite/test-defines';

export default defineConfig({
  test: {
    globals: false,
    projects: [{ extends: true, test: { name: 'content:unit', include: ['src/**/*.spec.ts'], environment: 'node' } }],
  },
  define: {
    ...TEST_DEFINES,
    'import.meta.env.DEV': 'false',
    'import.meta.env.VITE_APP_DEBUG': '"true"',
    // On, so a test reads what the page reports through a bound fake Sentry.
    'import.meta.env.VITE_METRICS': '"true"',
  },
});
