// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/// <reference types="node" />

import { defineConfig } from 'eslint/config';
import { config, dynamicImportBan, importBans, onlyAllowedScopes, restrictedSyntax } from '@config/eslint/vite';

const message = 'ui holds primitives with no domain and no data source, so the packages built on it stay above it.';

// ui sits at the bottom of the UI stack: the packages built on it, the runtime, the data packages, `@dotli/config`,
// `@parity/*` and the chain client libraries all stay above it. The tooling configs may use `@config/*`.
const scopeBan = onlyAllowedScopes(
  ['@dotli/shared', '@dotli/metrics', '@config/eslint', '@config/vite', '@config/storybook'],
  message,
);
const dataLibraryBan = {
  group: ['polkadot-api', 'polkadot-api/*', '@polkadot-api/*', '@polkadot-labs/*'],
  message,
};

// The same, for `import()`. Of the workspace only shared and metrics pass.
const dynamicBan = dynamicImportBan(
  '^(?!@dotli.shared([^\\w-]|$)|@dotli.metrics([^\\w-]|$))(@dotli|@config|@parity|polkadot-api|@polkadot-api|@polkadot-labs)([^\\w-]|$)',
  message,
);

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
  ...importBans([scopeBan, dataLibraryBan]),
  // Shipped modules, stories and specs reach only shared and metrics of the workspace.
  ...importBans([onlyAllowedScopes(['@dotli/shared', '@dotli/metrics'], message), dataLibraryBan], ['src/**']),
  {
    rules: {
      'no-restricted-syntax': ['error', ...restrictedSyntax, dynamicBan],
    },
  },
]);
