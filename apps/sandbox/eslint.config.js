// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/// <reference types="node" />

import { defineConfig } from 'eslint/config';
import { config, importBans, onlyAllowedScopes } from '@config/eslint/vite';

export default defineConfig([
  { ignores: ['storybook-static/**'] },
  ...config,
  {
    languageOptions: {
      parserOptions: {
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  ...importBans([
    onlyAllowedScopes(
      [
        '@dotli/config',
        '@dotli/content',
        '@dotli/metrics',
        '@dotli/sandbox-wire',
        '@dotli/shared',
        '@dotli/ui',
        '@config/eslint',
        '@config/storybook',
        '@config/vite',
      ],
      'The sandbox renders a product, and never takes the runtime, the chains or the storage.',
    ),
  ]),
]);
