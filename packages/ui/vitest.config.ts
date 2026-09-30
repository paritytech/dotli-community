// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { defineConfig } from 'vitest/config';
import solid from '@solidjs/vite-plugin';

const HYDRATION_TESTS = 'tests/**/*.hydration.test.tsx';

// Two projects. In test mode @solidjs/vite-plugin compiles components
// non-hydratable for the DOM, which the component tests render with. The
// hydration tests compile hydratable, as the host build does (@dotli/
// astro-solid), to hydrate build-time markup the way the host page does.
export default defineConfig({
  define: {
    // getEnabledNetworks() requires VITE_NETWORKS (no default by design); the
    // test build supplies it the same way a deployment does.
    'import.meta.env.VITE_NETWORKS': '"paseo-next-v2,previewnet"',
  },
  // `npm run link:truapi` points @parity/truapi-provider at a checkout outside
  // this workspace, and its `?url` wasm import would be refused by Vite's
  // workspace-only file serving.
  server: { fs: { strict: false } },
  test: {
    globals: false,
    environment: 'happy-dom',
    projects: [
      {
        extends: true,
        plugins: [solid()],
        test: { name: 'ui', include: ['tests/**/*.test.{ts,tsx}'], exclude: [HYDRATION_TESTS] },
      },
      {
        extends: true,
        plugins: [solid({ ssr: true, solid: { hydratable: true } })],
        test: { name: 'ui:hydration', include: [HYDRATION_TESTS] },
      },
    ],
  },
});
