// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { defineConfig } from 'vitest/config';
import solid from '@solidjs/vite-plugin';
import { inlineScript } from '@config/vite/inline-script';

export default defineConfig({
  // The service worker inlines its head scripts, bundled as the build does.
  plugins: [inlineScript(), solid()],
  test: {
    globals: false,
    projects: [
      { extends: true, test: { name: 'sandbox:unit', include: ['src/**/*.spec.{ts,tsx}'], environment: 'node' } },
      // The screens' DOM, under happy-dom.
      {
        extends: true,
        test: { name: 'sandbox:functional', include: ['tests/**/*.test.ts'], environment: 'happy-dom' },
      },
    ],
  },
  define: {
    'import.meta.env.DEV': 'false',
    'import.meta.env.VITE_APP_DEBUG': '"true"',
    'import.meta.env.VITE_NETWORKS': '"paseo-next-v2,previewnet"',
  },
});
