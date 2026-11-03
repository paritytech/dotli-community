// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { defineConfig } from 'vitest/config';
import solid from '@solidjs/vite-plugin';

export default defineConfig({
  plugins: [solid()],
  test: {
    globals: false,
    projects: [
      {
        extends: true,
        test: { name: 'stores-solid:unit', include: ['src/**/*.spec.ts'], environment: 'node' },
        // Node's own conditions pick Solid's server build, whose effects never re-run.
        ssr: { resolve: { conditions: ['browser', 'development'] } },
      },
    ],
  },
});
