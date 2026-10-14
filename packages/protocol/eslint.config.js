// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/// <reference types="node" />

import { defineConfig } from 'eslint/config';
import { config, importBans, onlyAllowedScopes } from '@config/eslint/vite';

export default defineConfig([
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
        '@dotli/chains',
        '@dotli/config',
        '@dotli/metrics',
        '@dotli/resolver',
        '@dotli/shared',
        '@config/eslint',
        '@config/vite',
      ],
      "protocol is the page's side of the protocol frame, below the apps.",
    ),
  ]),
]);
