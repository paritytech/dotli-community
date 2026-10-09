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
  // `npm run link:truapi` points @parity/truapi-provider outside the workspace, and Vite's
  // strict file serving would refuse its `?url` wasm import.
  server: { fs: { strict: false } },
  css: { modules: cssModules() },
  test: {
    globals: false,
    environment: 'happy-dom',
    name: 'ui',
    include: ['tests/**/*.test.{ts,tsx}'],
    setupFiles: ['tests/setup/popover-polyfill.ts'],
    // So `s['foo']` is a real scoped class in tests rather than undefined.
    css: { include: [/\.module\.css$/], modules: { classNameStrategy: 'scoped' } },
  },
});
