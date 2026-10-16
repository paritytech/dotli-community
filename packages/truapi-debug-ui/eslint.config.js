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
      group: ['@polkadot-labs/*', '@polkadot-api/*'],
      message: 'The debug panel reads keys and chains through its host port, never through a chain or crypto library.',
    },
    {
      // Its own kit stays its own: of the ui package only the Solid glue that reads a store and mounts a root, and
      // the pointer drag, whose pointer and selection rules must hold the same on every drag of the page.
      group: ['@dotli/ui'],
      allowImportNames: ['useStore', 'mountRoot', 'createDrags'],
      message:
        'The debug panel keeps its own components and tokens. It takes only useStore, mountRoot and createDrags from the ui package.',
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
      ],
      'The debug panel reads the host through its port and the debug bus, the network config, and archive types and the encryption check from content. It takes no runtime, chain or storage package, and of the ui package only useStore, mountRoot and createDrags.',
    ),
  ]),
]);
