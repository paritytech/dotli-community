// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/// <reference types="node" />

import { defineConfig } from 'eslint/config';
import { config, fixedConfigOnly, importBans, onlyAllowedScopes } from '@config/eslint/vite';

const scopeBan = onlyAllowedScopes(
  [
    '@dotli/chains',
    '@dotli/config',
    '@dotli/metrics',
    '@dotli/protocol',
    '@dotli/resolver',
    '@dotli/shared',
    '@dotli/storage',
    '@config/eslint',
    '@config/vite',
  ],
  'The protocol app serves chains and names to every tab, and never takes the UI.',
);

export default defineConfig([
  ...config,
  {
    languageOptions: {
      parserOptions: {
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  ...importBans([scopeBan]),
  ...importBans([scopeBan, fixedConfigOnly], ['src/protocol-worker.ts', 'src/light-client-service.ts']),
]);
