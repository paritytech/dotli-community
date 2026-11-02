// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { defineConfig } from 'vite';
import { createDotliApp } from '@config/vite/app';
import { modeSync } from '@config/vite/mode-sync';
import { LOCAL_ROOTS } from '@dotli/config/local-roots';

const app = createDotliApp({ appDir: import.meta.dirname, site: 'protocol', roots: LOCAL_ROOTS });

export default defineConfig(
  app.createViteConfig({
    base: app.base,
    plugins: [modeSync()],
    server: {
      port: 4003,
    },
  }),
);
