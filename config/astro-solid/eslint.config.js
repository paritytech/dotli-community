// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/// <reference types="node" />

import { defineConfig } from 'eslint/config';
import { config } from '@config/eslint/vite';

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
    // The integration entry is imported by astro.config.ts, which Node
    // loads directly, like a vite.config.ts: its imports name `.ts` files.
    files: ['src/index.ts'],
    rules: {
      'no-restricted-imports': 'off',
    },
  },
]);
