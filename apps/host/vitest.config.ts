// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { defineConfig } from 'vitest/config';
import solid from '@solidjs/vite-plugin';

export default defineConfig({
  plugins: [solid()],
  test: {
    // The Playwright suites have their own configs.
    include: ['tests/unit/**/*.test.{ts,tsx}', 'src/**/*.test.{ts,tsx}'],
    environment: 'happy-dom',
    globals: false,
  },
  define: {
    // On, so tests assert the real span tree against a fake Sentry, not a stripped build's no-op handles.
    'import.meta.env.VITE_METRICS': '"true"',
    'import.meta.env.VITE_RESOLUTION_SAMPLE_RATE': '"1"',
  },
});
