// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/// <reference types="node" />

import { defineConfig } from 'eslint/config';
import { config } from '@config/eslint/vite';

export default defineConfig([
  // Byte-pinned upstream runtime assets are attested by the runtime sync check.
  { ignores: ['public/polkavm-runtime/**'] },
  ...config,
  {
    languageOptions: {
      parserOptions: {
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
]);
