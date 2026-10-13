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
    {
      group: ['@polkadot-labs/*', '@polkadot-api/*'],
      message: 'The debug panel reads keys and chains through its host port, never through a chain or crypto library.',
    },
    onlyAllowedScopes(
      [
        '@dotli/truapi-debug-ui',
        '@dotli/truapi-debug',
        '@dotli/config',
        '@dotli/shared',
        '@dotli/metrics',
        '@dotli/content',
        '@config/eslint',
        '@config/vite',
        '@config/storybook',
      ],
      'The debug panel shares nothing with the ui packages, the runtime or the data packages. It reads the host through its port and the network config.',
    ),
  ]),
]);
