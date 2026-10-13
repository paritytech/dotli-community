// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/// <reference types="node" />

import { defineConfig } from 'eslint/config';
import { config, dynamicImportBan, importBans, onlyAllowedScopes, restrictedSyntax } from '@config/eslint/vite';

const message =
  'ui-core is what page startup may import from the UI, so it imports no Solid, no JSX, no CSS and of the workspace only shared.';

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
    onlyAllowedScopes(['@dotli/shared', '@config/eslint'], message),
    { group: ['solid-js', 'solid-js/*', '@solidjs/*'], message },
    { regex: '\\.css$', message },
  ]),
  {
    rules: {
      'no-restricted-syntax': [
        'error',
        ...restrictedSyntax,
        // The same, for `import()`.
        dynamicImportBan('^(?!@dotli.shared([^\\w-]|$))(@dotli|@config|@parity|solid-js|@solidjs)([^\\w-]|$)', message),
        dynamicImportBan('\\.css$', message),
        { selector: 'JSXElement, JSXFragment', message },
      ],
    },
  },
]);
