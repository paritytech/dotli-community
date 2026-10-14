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
    {
      // Its own kit stays its own: of the ui package only the Solid glue that reads a store and mounts a root.
      group: ['@dotli/ui'],
      allowImportNames: ['useStore', 'mountRoot'],
      message:
        'The debug panel keeps its own components and tokens. It takes only useStore and mountRoot from the ui package.',
    },
    onlyAllowedScopes(
      [
        '@dotli/truapi-debug-ui',
        '@dotli/truapi-debug',
        '@dotli/config',
        '@dotli/shared',
        '@dotli/metrics',
        '@dotli/content',
        '@dotli/ui',
        '@config/eslint',
        '@config/vite',
        '@config/storybook',
      ],
      'The debug panel shares nothing with the runtime or the data packages. It reads the host through its port and the network config, and takes only useStore and mountRoot of the ui package.',
    ),
  ]),
]);
