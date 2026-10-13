// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { defineConfig } from 'vitest/config';
import solid from '@solidjs/vite-plugin';
import { inlineScript } from '@config/vite/inline-script';
import { TEST_DEFINES } from '@config/vite/test-defines';

export default defineConfig({
  // The service worker inlines its head scripts, bundled as the build does.
  plugins: [inlineScript(), solid()],
  test: {
    globals: false,
    name: 'sandbox:unit',
    include: ['src/**/*.spec.{ts,tsx}'],
    environment: 'node',
  },
  define: {
    ...TEST_DEFINES,
    'import.meta.env.DEV': 'false',
    'import.meta.env.VITE_APP_DEBUG': '"true"',
  },
});
