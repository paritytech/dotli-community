// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import astro from 'eslint-plugin-astro';
import tseslint from 'typescript-eslint';
import { defineConfig } from 'eslint/config';
import { config as viteConfig } from './vite.js';

/**
 * ESLint configuration for Astro apps: the Vite config for their TypeScript,
 * plus eslint-plugin-astro's recommended rules for `.astro` components, their
 * frontmatter and their `<script>`s. The type-aware rules are off in
 * components, which TypeScript's project service does not load; `astro
 * check` type-checks them.
 */
export const config = defineConfig([
  ...viteConfig,
  ...astro.configs.recommended,
  {
    files: ['**/*.astro', '**/*.astro/*.js', '**/*.astro/*.ts'],
    extends: [tseslint.configs.disableTypeChecked],
  },
]);
