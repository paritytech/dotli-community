// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/// <reference types="node" />

import { defineConfig } from 'eslint/config';
import { config, importBans } from '@config/eslint/vite';

// No sandbox module imports the entity views, so none of their code or stylesheets reach the sandbox's boot.
const entitiesBan = {
  group: ['@dotli/ui-entities', '@dotli/ui-entities/*'],
  message: 'The sandbox mounts no entity view. Its dialogs are ModalView data that ui renders.',
};

// Boot takes its UI only from ui-core, and the icons its dialogs carry. The retry screen's view is the sandbox's one
// Solid component, in a lazy chunk.
const uiBan = {
  regex: '^@dotli/ui(/(?!icons$|styles\\.css$).*)?$',
  message:
    'Boot imports UI only from @dotli/ui-core and @dotli/ui/icons. The retry screen view, loaded through src/lazy.ts, is the one module that renders Solid.',
};

const viewsBan = {
  regex: '^@dotli/ui-widgets/views$',
  message: 'The error frame and the screen mount are Solid, so only the retry screen view, a lazy chunk, imports them.',
};

// src/lazy.ts loads the password dialog and the retry screen view on demand, through import(), which the rule does not
// check. Any other import of them would pull them into boot. The dialog's spec and the view's story may name them too.
const retryView = ['src/RetryScreen*.tsx'];
const viewImporters = ['src/password-dialog*.ts', ...retryView];

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
  ...importBans([entitiesBan, uiBan, viewsBan], ['src/**'], retryView),
  // The retry screen's view draws the brand mark in the error page's screen mount.
  ...importBans([entitiesBan], retryView),
  ...importBans(
    [
      entitiesBan,
      uiBan,
      viewsBan,
      {
        regex: '^\\.{1,2}/(.*/)?(password-dialog|RetryScreen)(\\.js)?$',
        message:
          'Boot never imports the password dialog or the retry screen view. src/lazy.ts loads them, and their types come from that loader.',
      },
    ],
    ['src/**'],
    viewImporters,
  ),
]);
