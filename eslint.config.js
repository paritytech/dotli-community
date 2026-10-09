// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/// <reference types="node" />

import { defineConfig } from 'eslint/config';
import { config } from '@config/eslint/vite';

// The root lints only scripts/. Every workspace lints itself.
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
    // Node runs these CLI tools directly from the shell, so they import `.ts` paths, print to stdout and have no turbo
    // env inputs to declare.
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
