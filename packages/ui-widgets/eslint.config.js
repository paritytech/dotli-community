// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/// <reference types="node" />

import { defineConfig } from 'eslint/config';
import { config, importBans, onlyAllowedScopes, restrictedSyntax } from '@config/eslint/vite';

const packageBan = onlyAllowedScopes(
  [
    '@dotli/ui-widgets',
    '@dotli/ui',
    '@dotli/ui-core',
    '@dotli/shared',
    '@config/eslint',
    '@config/vite',
    '@config/storybook',
  ],
  'ui-widgets are page screens and overlays both apps show, built on ui and ui-core alone. The views, the runtime and the data stay with the apps.',
);

const bootMessage =
  'The host and sandbox boot import this package, so only the lazy chunks (the overlays, the error page view, loaded through import()) and the views entry may reach Solid.';
const bootUiMessage = `Boot imports UI only from @dotli/ui-core and @dotli/ui/icons. ${bootMessage}`;

// Everything shipped but the lazy chunks and the views entry is on both apps' boot path.
const bootExcept = [
  'src/overlays/*.tsx',
  'src/error-page/*.tsx',
  'src/mount-screen.tsx',
  'src/views.ts',
  'src/**/*.stories.tsx',
  'src/**/*.spec.ts',
];

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
  ...importBans([packageBan]),
  ...importBans(
    [
      packageBan,
      {
        group: ['solid-js', 'solid-js/*', '@solidjs/*'],
        message: bootMessage,
      },
      {
        regex: '^\\.{1,2}/(.*/)?(mount|ModalOutlet|PromptDialog|ErrorPage|ErrorFrame|mount-screen|views)(\\.js)?$',
        message: bootMessage,
      },
      { regex: '^@dotli/ui(/(?!icons$|styles\\.css$).*)?$', message: bootUiMessage },
    ],
    ['src/**'],
    bootExcept,
  ),
  {
    // JSX compiles to a Solid import that the import bans never see.
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    ignores: bootExcept,
    rules: {
      'no-restricted-syntax': [
        'error',
        ...restrictedSyntax,
        { selector: 'JSXElement, JSXFragment', message: bootMessage },
      ],
    },
  },
]);
