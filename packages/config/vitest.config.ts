// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'happy-dom',
    globals: false,
  },
  define: {
    'import.meta.env.DEV': 'false',
    'import.meta.env.VITE_APP_DEBUG': '"true"',
    // getEnabledNetworks() requires VITE_NETWORKS, with no default by design.
    'import.meta.env.VITE_NETWORKS': '"paseo-next-v2,previewnet"',
    // Lets tests exercise runtime overrides through globalThis.__DOTLI_NETWORK__. Without that global, every reader
    // keeps the built-in tables.
    'import.meta.env.VITE_RUNTIME_NETWORK_CONFIG': '"true"',
  },
});
