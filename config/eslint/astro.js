// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import astro from 'eslint-plugin-astro';
import tseslint from 'typescript-eslint';
import { defineConfig } from 'eslint/config';
import { config as viteConfig } from './vite.js';

/**
 * ESLint configuration for Astro apps.
 * Type-aware rules are off in components, which the TypeScript project service does not load. `astro check` covers
 * them.
 */
export const config = defineConfig([
  ...viteConfig,
  ...astro.configs.recommended,
  {
    files: ['**/*.astro', '**/*.astro/*.js', '**/*.astro/*.ts'],
    extends: [tseslint.configs.disableTypeChecked],
  },
]);
