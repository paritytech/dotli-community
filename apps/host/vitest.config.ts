// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { defineConfig } from 'vitest/config';
import solid from '@solidjs/vite-plugin';

// Unit specs sit beside their module and run under Node. The functional tests of the host's views, the islands and the
// shell's DOM bindings run under happy-dom. The Playwright suites have their own configs.
export default defineConfig({
  plugins: [solid()],
  test: {
    globals: false,
    projects: [
      {
        extends: true,
        test: {
          name: 'host:unit',
          include: ['src/**/*.spec.{ts,tsx}'],
          exclude: ['src/islands/**'],
          environment: 'node',
        },
      },
      {
        extends: true,
        test: { name: 'host:islands', include: ['src/islands/**/*.spec.{ts,tsx}'], environment: 'node' },
        // The islands' bindings run Solid, and Node's own conditions pick its server build, whose effects never re-run.
        ssr: { resolve: { conditions: ['browser', 'development'] } },
      },
      {
        extends: true,
        test: {
          name: 'host:functional',
          include: ['tests/{components,islands,shell}/**/*.test.{ts,tsx}'],
          environment: 'happy-dom',
          setupFiles: ['tests/setup/popover-polyfill.ts'],
        },
      },
    ],
  },
  define: {
    // On, so tests assert the real span tree against a fake Sentry, not a stripped build's no-op handles.
    'import.meta.env.VITE_METRICS': '"true"',
    'import.meta.env.VITE_RESOLUTION_SAMPLE_RATE': '"1"',
    // getEnabledNetworks() has no default, so tests supply VITE_NETWORKS like a deployment does.
    'import.meta.env.VITE_NETWORKS': '"paseo-next-v2,previewnet"',
  },
});
