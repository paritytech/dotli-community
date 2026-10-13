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
    {
      group: ['solid-js', '@solidjs/*'],
      message: 'The runtime never renders. It asks the app through the ports it is given.',
    },
    onlyAllowedScopes(
      [
        '@dotli/protocol',
        '@dotli/storage',
        '@dotli/chains',
        '@dotli/content',
        '@dotli/bitswap',
        '@dotli/resolver',
        '@dotli/config',
        '@dotli/sandbox-wire',
        '@dotli/shared',
        '@dotli/metrics',
        '@dotli/truapi-debug',
        '@parity/*',
        '@config/eslint',
      ],
      'The runtime holds the host side of TrUAPI and the session over the data packages. No UI package is below it.',
    ),
  ]),
]);
