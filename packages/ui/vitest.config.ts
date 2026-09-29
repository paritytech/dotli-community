// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { defineConfig } from 'vitest/config';
import solid from '@solidjs/vite-plugin';

// In test mode @solidjs/vite-plugin compiles components non-hydratable for
// the DOM, which is how the host build compiles its client code
// (apps/host/vite.config.ts): nothing on the client hydrates.
export default defineConfig({
  plugins: [solid()],
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
    name: 'ui',
    include: ['tests/**/*.test.{ts,tsx}'],
    environment: 'happy-dom',
    globals: false,
  },
});
