// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/// <reference types="node" />

import { defineConfig } from 'eslint/config';
import { config } from '@dotli/eslint-config/vite';

// The shared config's `no-restricted-syntax` entries. A file override
// replaces a rule's options rather than merging them, so the shell override
// below repeats these.
const sharedRule = config
  .map(entry => entry.rules?.['no-restricted-syntax'])
  .filter(rule => rule !== undefined)
  .at(-1);
const sharedRestrictedSyntax = Array.isArray(sharedRule) ? sharedRule.slice(1) : [];

export default defineConfig([
  ...config,
  {
    languageOptions: {
      parserOptions: {
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // The shell's islands (components/shell/islands.tsx) render into a
    // detached container, which is where Solid delegates `onClick`-style
    // events: they would never fire once the island is swapped in. The
    // landing page follows the same rule, since it moves island nodes into
    // its own tree.
    files: ['src/components/shell/**/*.tsx', 'src/components/landing/**/*.tsx'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...sharedRestrictedSyntax,
        {
          selector: 'JSXAttribute[name.name=/^on[A-Z]/]',
          message:
            "Solid's delegated events do nothing in a shell island (it renders into a detached container). Add a native listener in a callback ref instead (see components/shell/islands.tsx).",
        },
      ],
    },
  },
  {
    // Shell.tsx is prerendered into index.html and never runs on the client,
    // so anything reactive in it would be frozen at its build-time state. It
    // may import types only: no components, no signals, no stores.
    files: ['src/components/shell/Shell.tsx'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['*'],
              allowTypeImports: true,
              message: 'Shell.tsx is static markup the client never runs: import types only (see shell.server.tsx).',
            },
          ],
        },
      ],
    },
  },
]);
