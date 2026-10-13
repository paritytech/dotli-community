// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { defineConfig } from 'vitest/config';
import { inlineScript } from '@config/vite/inline-script';

export default defineConfig({
  // The injector inlines the checker bundled, as the sandbox's build does.
  plugins: [inlineScript()],
  test: {
    globals: false,
    projects: [
      { extends: true, test: { name: 'sandbox-checker:unit', include: ['src/**/*.spec.ts'], environment: 'node' } },
    ],
  },
});
