// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { defineConfig } from 'vite';
import { dotliApp } from '@config/vite/app';
import { buildInfo } from '@config/vite/build-info';
import { appBuildOptions, rolldownOptions } from '@config/vite/build-options';
import { modeSync } from '@config/vite/mode-sync';
import { runtimeNetworkConfigScript } from '@config/vite/runtime-network-config';
import { stripAnalytics } from '@dotli/metrics/vite';

const app = dotliApp(import.meta.dirname);

const OUT_DIR = 'dist';

export default defineConfig({
  envDir: app.envDir,
  base: app.base,
  plugins: [
    stripAnalytics(process.env['VITE_METRICS'] !== 'true'),
    app.wasm(),
    runtimeNetworkConfigScript(),
    buildInfo('protocol'),
    modeSync(),
    app.sentry(),
  ],
  worker: {
    plugins: () => [stripAnalytics(process.env['VITE_METRICS'] !== 'true')],
    rolldownOptions: rolldownOptions(),
  },
  optimizeDeps: {
    exclude: ['@polkadot-api/wasm-executor'],
  },
  build: {
    ...appBuildOptions(),
    target: 'esnext',
    modulePreload: { polyfill: false },
    outDir: OUT_DIR,
    sourcemap: 'hidden',
  },
  server: {
    // Must match DEV_PROTOCOL_PORT in @dotli/config.
    port: 4323,
    strictPort: true,
    headers: {
      'Access-Control-Allow-Origin': '*',
      // As nginx sends.
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
      'Cross-Origin-Opener-Policy': 'same-origin',
    },
  },
});
