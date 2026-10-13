// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { defineConfig } from 'vitest/config';
import solid from '@solidjs/vite-plugin';
import { cssModules } from '@config/vite/css-modules';

// In test mode the Solid plugin compiles non-hydratable DOM output, which the component tests render with.
export default defineConfig({
  plugins: [solid()],
  define: {
    // getEnabledNetworks() requires VITE_NETWORKS and has no default by design.
    'import.meta.env.VITE_NETWORKS': '"paseo-next-v2,previewnet"',
  },
  css: { modules: cssModules() },
  test: {
    globals: false,
    // So `s['foo']` is a real scoped class in tests rather than undefined.
    css: { include: [/\.module\.css$/], modules: { classNameStrategy: 'scoped' } },
    projects: [
      {
        extends: true,
        test: { name: 'ui-widgets:unit', include: ['src/**/*.spec.{ts,tsx}'], environment: 'node' },
        // Node's own conditions pick Solid's server build, whose effects never re-run.
        ssr: { resolve: { conditions: ['browser', 'development'] } },
      },
      {
        extends: true,
        test: { name: 'ui-widgets:functional', include: ['tests/**/*.test.{ts,tsx}'], environment: 'happy-dom' },
      },
    ],
  },
});
