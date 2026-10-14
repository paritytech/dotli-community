// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { defineConfig } from 'vite';
import { dotliApp } from '@config/vite/app';
import { modeSync } from '@config/vite/mode-sync';

const app = dotliApp(import.meta.dirname, 'protocol');

export default defineConfig(
  app.vite({
    base: app.base,
    plugins: [modeSync()],
    server: {
      // Must match DEV_PROTOCOL_PORT in @dotli/config.
      port: 4323,
    },
  }),
);
