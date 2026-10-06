// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { defineConfig } from 'vitest/config';
import solid from '@solidjs/vite-plugin';
import { cssModules } from '@config/vite/css-modules';

// In test mode @solidjs/vite-plugin compiles components non-hydratable for
// the DOM, which the component tests render with.
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
  css: { modules: cssModules() },
  test: {
    globals: false,
    environment: 'happy-dom',
    name: 'ui',
    include: ['tests/**/*.test.{ts,tsx}'],
    setupFiles: ['tests/setup/popover-polyfill.ts', 'tests/setup/floating-surfaces.ts'],
    // Process CSS modules with the app naming, so `s['foo']` is a real scoped
    // class in tests rather than undefined.
    css: { include: [/\.module\.css$/], modules: { classNameStrategy: 'scoped' } },
  },
});
