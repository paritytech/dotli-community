// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { defineConfig } from 'vitest/config';

// Unit specs only. The panel's DOM is tested by the stories in @dotli/truapi-debug-ui.
export default defineConfig({
  define: {
    // On, so a spec reads what the bus reports through a bound fake Sentry.
    'import.meta.env.VITE_METRICS': '"true"',
  },
  test: {
    globals: false,
    projects: [
      { extends: true, test: { name: 'truapi-debug:unit', include: ['src/**/*.spec.ts'], environment: 'node' } },
    ],
  },
});
