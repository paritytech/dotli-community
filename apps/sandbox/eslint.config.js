// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/// <reference types="node" />

import { defineConfig } from 'eslint/config';
import { config, importBans } from '@config/eslint/vite';

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
      group: ['@dotli/ui-entities', '@dotli/ui-entities/*'],
      message: 'The sandbox mounts no entity view. Its dialogs are ModalView data that ui renders.',
    },
  ]),
]);
