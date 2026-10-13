// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/// <reference types="node" />

import { defineConfig } from 'eslint/config';
import { config, dynamicImportBan, importBans, onlyAllowedScopes, restrictedSyntax } from '@config/eslint/vite';

const message =
  'ui-entities views take props only. The app binds them to stores and data, and @parity/truapi is in only for its types and codecs.';

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
    onlyAllowedScopes(['@dotli/ui', '@parity/truapi', '@config/eslint', '@config/vite', '@config/storybook'], message),
  ]),
  {
    rules: {
      // The same, for `import()`.
      'no-restricted-syntax': [
        'error',
        ...restrictedSyntax,
        dynamicImportBan(
          '^(?!@dotli.ui([^\\w-]|$)|@parity.truapi([^\\w-]|$))(@dotli|@config|@parity)([^\\w-]|$)',
          message,
        ),
      ],
    },
  },
]);
