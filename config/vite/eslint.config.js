// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/// <reference types="node" />

import { defineConfig } from 'eslint/config';
import { config, importBans, onlyAllowedScopes } from '@config/eslint/vite';

const TOOLING_SCOPES = onlyAllowedScopes(['@config/eslint'], 'Tooling imports only tooling.');

export default defineConfig([
  ...config,
  {
    languageOptions: {
      parserOptions: {
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  ...importBans([TOOLING_SCOPES]),
  {
    // Node loads these through the app configs directly, so their imports name `.ts` files. The `.ts` and test-only
    // module bans are lifted. The workspace-import ban still holds.
    files: [
      'src/app.ts',
      'src/buildInfoPlugin.ts',
      'src/createLocalServing.ts',
      'src/getFileHeaders.ts',
      'src/getHeaderPolicy.ts',
      'src/getPolicyHeaders.ts',
      'src/resolveFile.ts',
      'src/serviceWorker.ts',
      'src/serving.ts',
      'src/spaFallback.ts',
    ],
    rules: {
      'no-restricted-imports': ['error', { patterns: [TOOLING_SCOPES] }],
    },
  },
]);
