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
        '@dotli/ui-widgets',
        '@dotli/ui',
        '@dotli/shared',
        '@dotli/metrics',
        '@config/eslint',
        '@config/vite',
        '@config/storybook',
      ],
      'ui-widgets are page screens and overlays both apps show, built on ui, shared and metrics. The views, the runtime and the data stay with the apps.',
    ),
  ]),
]);
