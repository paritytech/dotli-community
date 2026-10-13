// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { defineConfig } from 'vitest/config';
import solid from '@solidjs/vite-plugin';

// Unit specs sit beside their module under Node, where the server renderer runs. Client hydration needs a DOM, so it
// is a functional test. Both compile hydratable to match the integration, which the plugin's test posture would not.
export default defineConfig({
  plugins: [solid({ ssr: true, solid: { hydratable: true } })],
  test: {
    globals: false,
    projects: [
      {
        extends: true,
        // Solid's test posture resolves browser builds, but the server renderer needs the server ones.
        resolve: { conditions: ['node'] },
        test: { name: 'astro-solid:unit', include: ['src/**/*.spec.{ts,tsx}'], environment: 'node' },
      },
      {
        extends: true,
        test: { name: 'astro-solid:functional', include: ['tests/**/*.test.{ts,tsx}'], environment: 'happy-dom' },
      },
    ],
  },
});
