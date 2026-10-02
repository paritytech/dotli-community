// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { defineConfig } from 'vitest/config';
import solid from '@solidjs/vite-plugin';

// Two projects, one per side of the renderer: the server entry runs under
// Node with Solid's server codegen, the client entry under happy-dom with
// its DOM codegen. Both compile hydratable, as the integration does
// (src/index.ts), where @solidjs/vite-plugin's test posture would not.
export default defineConfig({
  plugins: [solid({ ssr: true, solid: { hydratable: true } })],
  test: {
    globals: false,
    projects: [
      {
        extends: true,
        // Solid's test posture resolves its packages for the browser; the
        // server renderer needs their server builds, as under Astro.
        resolve: { conditions: ['node'] },
        test: { name: 'astro-solid:server', include: ['tests/server.test.tsx'], environment: 'node' },
      },
      {
        extends: true,
        test: { name: 'astro-solid:client', include: ['tests/client.test.tsx'], environment: 'happy-dom' },
      },
    ],
  },
});
