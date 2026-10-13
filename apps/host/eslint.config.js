// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/// <reference types="node" />

import { defineConfig } from 'eslint/config';
import { config } from '@config/eslint/astro';
import { importBans } from '@config/eslint/vite';

// Astro hydrates the islands and src/lazy.ts loads the rest on demand. Everything else can reach boot, where a view's
// stylesheet stays even when tree shaking drops its code. The host's own views render only inside islands and lazy
// chunks.
const chrome = [
  'account',
  'chains',
  'chat',
  'landing',
  'loading',
  'no-content',
  'permissions',
  'sandbox-checker',
  'settings',
  'shield',
  'topbar',
];
const viewImporters = [
  'src/islands/**',
  ...chrome.map(folder => `src/components/${folder}/**`),
  'src/bridge-ports.ts',
  'src/host-prompts*.ts',
  'src/load-failure*.ts',
];

export default defineConfig([
  ...config,
  {
    languageOptions: {
      parserOptions: {
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  ...importBans(
    [
      {
        group: ['@dotli/ui-entities', '@dotli/ui-entities/*'],
        message:
          'Boot, state and controllers never import the views. An island binds them, or a module that loads in a lazy chunk. Pass the view a formatted value.',
      },
      {
        regex: '^@dotli/ui(/(?!icons$|styles\\.css$).*)?$',
        message:
          'Boot imports UI only from @dotli/ui-core and @dotli/ui/icons. A Solid component renders inside an island or a lazy chunk.',
      },
      {
        regex: '^@dotli/ui-widgets/views$',
        message: 'The error frame is Solid, so boot never imports it. A view that src/lazy.ts loads composes it.',
      },
      {
        regex: '^\\.{1,2}/(.*/)?islands/',
        message: 'Islands are hydrated by Astro, so boot never imports one.',
      },
      {
        regex: `^\\.{1,2}/(.*/)?(${chrome.join('|')})/`,
        message:
          'The host views render inside islands and lazy chunks, so boot never imports them. An island binds them, or src/lazy.ts loads them.',
      },
    ],
    ['src/**'],
    viewImporters,
  ),
  {
    // The Playwright suites read env knobs straight from the shell, never through a turbo task, so turbo has no
    // cache to key on them.
    files: ['tests/**/*.ts'],
    rules: {
      'turbo/no-undeclared-env-vars': 'off',
    },
  },
]);
