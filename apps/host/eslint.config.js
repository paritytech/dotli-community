// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/// <reference types="node" />

import { defineConfig, globalIgnores } from 'eslint/config';
import { config } from '@config/eslint/astro';
import { featureBoundaries } from '@config/eslint/vite';

export default defineConfig([
  ...config,
  ...featureBoundaries(),
  // The functional suite's global setup builds the wire bundle here.
  globalIgnores(['tests/functional/.wire/']),
  {
    languageOptions: {
      parserOptions: {
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // The Playwright suites read env knobs straight from the shell, never through a turbo task, so turbo has no
    // cache to key on them.
    files: ['tests/**/*.ts', 'src/**/__tests__/**/*.ts', 'src/**/__tests__/**/*.tsx'],
    rules: {
      'turbo/no-undeclared-env-vars': 'off',
    },
  },
  {
    // Node runs this script directly from the shell, so it imports `.ts` paths.
    files: ['tests/performance/compare.ts'],
    rules: {
      'no-restricted-imports': 'off',
    },
  },
]);
