// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/// <reference types="node" />

import { defineConfig } from 'eslint/config';
import { config } from '@config/eslint/astro';

export default defineConfig([
  ...config,
  {
    languageOptions: {
      parserOptions: {
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // The Playwright suites read env knobs straight from the shell, never through a turbo task, so turbo has no
    // cache to key on them. The Vitest unit tests run under turbo and keep the rule.
    files: ['tests/**/*.ts'],
    ignores: ['tests/unit/**'],
    rules: {
      'turbo/no-undeclared-env-vars': 'off',
    },
  },
]);
