// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/// <reference types="node" />

import { defineConfig } from 'eslint/config';
import { config, fixedServicesConfigOnly } from '@config/eslint/vite';

export default defineConfig([
  ...config,
  {
    languageOptions: {
      parserOptions: {
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  ...fixedServicesConfigOnly(['src/protocol-worker.ts', 'src/light-client-service.ts']),
]);
