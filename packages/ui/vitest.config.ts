// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { defineConfig } from 'vitest/config';
import solid from '@solidjs/vite-plugin';
import { cssModules } from '@config/vite/css-modules';

// In test mode the Solid plugin compiles non-hydratable DOM output, which the component tests render with.
export default defineConfig({
  plugins: [solid()],
  css: { modules: cssModules() },
  define: {
    // On, so tests read the counts from a fake Sentry. A build without metrics compiles every call out.
    'import.meta.env.VITE_METRICS': '"true"',
  },
  test: {
    globals: false,
    // So `s['foo']` is a real scoped class in tests rather than undefined.
    css: { include: [/\.module\.css$/], modules: { classNameStrategy: 'scoped' } },
    projects: [
      {
        extends: true,
        test: {
          name: 'ui:unit',
          include: ['src/**/*.spec.{ts,tsx}'],
          environment: 'node',
        },
        // Node's own conditions pick Solid's server build, whose effects never re-run.
        ssr: { resolve: { conditions: ['browser', 'development'] } },
      },
      {
        extends: true,
        test: {
          name: 'ui:functional',
          include: ['tests/**/*.test.{ts,tsx}'],
          environment: 'happy-dom',
          setupFiles: ['tests/setup.ts'],
        },
      },
    ],
  },
});
