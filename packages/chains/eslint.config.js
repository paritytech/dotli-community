// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/// <reference types="node" />

import { defineConfig } from 'eslint/config';
import { config, fixedConfigOnly, importBans, onlyAllowedScopes } from '@config/eslint/vite';

const scopeBan = onlyAllowedScopes(
  ['@dotli/config', '@dotli/metrics', '@dotli/shared', '@parity/truapi-provider', '@config/eslint', '@config/vite'],
  'chains holds the light client and the chain pool, below the protocol and the resolver.',
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
  ...importBans([scopeBan, fixedConfigOnly], ['src/provider.ts']),
]);
