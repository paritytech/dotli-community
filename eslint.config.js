// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/// <reference types="node" />

import { defineConfig } from 'eslint/config';
import { config } from '@config/eslint/vite';

// The repository root holds only the Node scripts under scripts/. Every
// workspace lints itself through its own config.
export default defineConfig([
  { ignores: ['apps/**', 'config/**', 'packages/**', 'docs/**', 'vendor/**'] },
  ...config,
  {
    languageOptions: {
      parserOptions: {
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // Node runs these directly, so they import `.ts` paths. They are CLI
    // tools whose stdout is their output, started from the shell rather than
    // through a turbo task, so turbo has no env inputs to declare for them.
    files: ['scripts/**/*.ts'],
    rules: {
      'no-console': 'off',
      'no-restricted-imports': 'off',
      'turbo/no-undeclared-env-vars': 'off',
    },
  },
  {
    // node:test's `describe` and `it` return promises the runner awaits.
    files: ['scripts/**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'off',
    },
  },
]);
