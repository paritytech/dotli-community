// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { sentryVitePlugin } from '@sentry/vite-plugin';
import { defineConfig, type Plugin, type PluginOption } from 'vite';
import { resolve } from 'node:path';
import wasmPlugin from 'vite-plugin-wasm';
import { buildInfo } from '@config/vite/build-info';
import { appBuildOptions, rolldownOptions } from '@config/vite/build-options';
import { runtimeNetworkConfigScript } from '@config/vite/runtime-network-config';
import { provideSentryRelease, sentryUploadRelease } from '@config/vite/sentry-release';
import { stripAnalytics } from '@dotli/metrics/vite';

// vite-plugin-wasm types its ESM entry with CommonJS-style declarations, so
// NodeNext sees the module object. At runtime the default export is the plugin.
const wasm = wasmPlugin as unknown as () => Plugin;

// Before Vite reads the environment, so the SDK reports the release the
// sourcemaps are uploaded under.
provideSentryRelease(import.meta.dirname);

const OUT_DIR = 'dist';
const APP_URL = process.env['VITE_APP_URL'] ?? '';

function sentry(): PluginOption {
  if (process.env['VITE_METRICS'] !== 'true') {
    return false;
  }
  if ((process.env['SENTRY_AUTH_TOKEN'] ?? '') === '') {
    return false;
  }
  return sentryVitePlugin({
    org: 'paritytech',
    project: 'dotli',
    telemetry: false,
    authToken: process.env['SENTRY_AUTH_TOKEN'],
    release: sentryUploadRelease(import.meta.dirname),
    sourcemaps: { filesToDeleteAfterUpload: ['./dist/**/*.map'] },
  });
}

export default defineConfig({
  envDir: resolve(import.meta.dirname, '../..'),
  base: APP_URL === '' ? '/' : new URL(APP_URL).pathname,
  plugins: [
    stripAnalytics(process.env['VITE_METRICS'] !== 'true'),
    wasm(),
    runtimeNetworkConfigScript(),
    buildInfo('protocol'),
    sentry(),
  ],
  worker: {
    plugins: () => [stripAnalytics(process.env['VITE_METRICS'] !== 'true')],
    rolldownOptions: rolldownOptions(),
  },
  define: {
    __BUILD_TARGET__: JSON.stringify('protocol'),
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
    headers: {
      'Access-Control-Allow-Origin': '*',
    },
  },
});
