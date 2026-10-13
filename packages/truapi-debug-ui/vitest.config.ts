// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { defineConfig } from 'vitest/config';
import solid from '@solidjs/vite-plugin';
import { cssModules } from '@config/vite/css-modules';
import { TEST_DEFINES } from '@config/vite/test-defines';

// In test mode the Solid plugin compiles non-hydratable DOM output, which the component tests render with.
export default defineConfig({
  plugins: [solid()],
  define: {
    ...TEST_DEFINES,
    // On, so a test reads what the page reports through a bound fake Sentry.
    'import.meta.env.VITE_METRICS': '"true"',
  },
  css: { modules: cssModules() },
  test: {
    globals: false,
    // So `s['foo']` is a real scoped class in tests rather than undefined.
    css: { include: [/\.module\.css$/], modules: { classNameStrategy: 'scoped' } },
    projects: [
      {
        extends: true,
        test: { name: 'truapi-debug-ui:unit', include: ['src/**/*.spec.{ts,tsx}'], environment: 'node' },
        // Node's own conditions pick Solid's server build, whose effects never re-run.
        ssr: { resolve: { conditions: ['browser', 'development'] } },
      },
      {
        extends: true,
        test: { name: 'truapi-debug-ui:functional', include: ['tests/**/*.test.{ts,tsx}'], environment: 'happy-dom' },
      },
    ],
  },
});
