// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/// <reference types="node" />

import { defineConfig } from 'eslint/config';
import { config, importBans, onlyAllowedScopes } from '@config/eslint/vite';

export default defineConfig([
  ...config,
  {
    languageOptions: {
      parserOptions: {
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  ...importBans([onlyAllowedScopes(['@config/eslint'], 'Tooling imports only tooling.')]),
  {
    // Node loads this through the app configs directly, so its imports name `.ts` files.
    files: ['src/app.ts', 'src/service-worker.ts', 'src/spa-fallback.ts', 'src/serving.ts'],
    rules: {
      'no-restricted-imports': 'off',
    },
  },
]);
