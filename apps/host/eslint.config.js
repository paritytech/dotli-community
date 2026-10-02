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
    // The Playwright suites (functional, e2e, performance) and their shared
    // config read run-time knobs such as PORT, HEADED or E2E_PRODUCT_URL,
    // which reach `playwright test` straight from the shell, never through a
    // turbo task, so turbo has no cache to key on them. The Vitest unit tests,
    // which run under the turbo `test` task, keep the rule.
    files: ['tests/**/*.ts'],
    ignores: ['tests/unit/**'],
    rules: {
      'turbo/no-undeclared-env-vars': 'off',
    },
  },
]);
