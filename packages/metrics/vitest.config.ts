// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    projects: [{ extends: true, test: { name: 'metrics:unit', include: ['src/**/*.spec.ts'], environment: 'node' } }],
  },
  define: {
    // On, so a test reads what the real module sends to a bound fake. A build with metrics off ships the no-op twin.
    'import.meta.env.VITE_METRICS': '"true"',
  },
});
