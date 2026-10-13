// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { defineConfig, build as viteBuild, type Plugin, type ResolvedConfig } from 'vite';
import { resolve } from 'node:path';
import solid from '@solidjs/vite-plugin';
import { dotliApp } from '@config/vite/app';
import { buildInfo } from '@config/vite/build-info';
import { appBuildOptions, rolldownOptions } from '@config/vite/build-options';
import { cssModules } from '@config/vite/css-modules';
import { inlineScript } from '@config/vite/inline-script';
import { runtimeNetworkConfigScript } from '@config/vite/runtime-network-config';
import { socialMetaTags } from '@config/vite/social-meta';
import { stripAnalytics } from '@dotli/metrics/vite';

const app = dotliApp(import.meta.dirname);

const OUT_DIR = 'dist';

function buildServiceWorker(): Plugin {
  // The page's resolved env settings, so the worker sees the same `.env` flags in the same mode.
  let env: Pick<ResolvedConfig, 'envDir' | 'mode'> = { envDir: false, mode: 'production' };
  return {
    name: 'build-service-worker',
    apply: 'build',
    configResolved(config) {
      env = { envDir: config.envDir, mode: config.mode };
    },
    async closeBundle() {
      // eslint-disable-next-line no-console -- build progress for the terminal.
      console.log(`\nBuilding Service Worker (app-sw) @ ${process.env['VITE_COMMIT_SHA'] ?? 'dev'}...`);
      // Takes VITE_COMMIT_SHA from the process environment, as the page does.
      await viteBuild({
        configFile: false,
        envDir: env.envDir,
        mode: env.mode,
        plugins: [inlineScript(), app.wasm()],
        build: {
          ...appBuildOptions({ codeSplitting: false }),
          emptyOutDir: false,
          outDir: OUT_DIR,
          lib: {
            entry: resolve(import.meta.dirname, 'src/app-sw.ts'),
            formats: ['es'],
            fileName: () => 'app-sw.js',
          },
          sourcemap: false,
        },
        logLevel: 'warn',
      });
      // eslint-disable-next-line no-console -- build progress for the terminal.
      console.log(`Service Worker built -> ${OUT_DIR}/app-sw.js\n`);
    },
  };
}

export default defineConfig({
  css: { modules: cssModules() },
  envDir: app.envDir,
  base: app.base,
  plugins: [
    stripAnalytics(process.env['VITE_METRICS'] !== 'true'),
    inlineScript(),
    solid(),
    app.wasm(),
    runtimeNetworkConfigScript(),
    buildInfo('app'),
    socialMetaTags({
      title: 'Polkadot Web',
      description:
        'A decentralized web browser that runs in your browser. Open any Polkadot app with trustless, client-side resolution and no servers in the loop.',
      siteName: 'Polkadot Web',
      image: '/icon-512.png',
      imageAlt: 'Polkadot logo',
    }),
    buildServiceWorker(),
    app.sentry(),
  ],
  worker: {
    plugins: () => [stripAnalytics(process.env['VITE_METRICS'] !== 'true')],
    rolldownOptions: rolldownOptions(),
  },
  build: {
    ...appBuildOptions(),
    target: 'esnext',
    modulePreload: { polyfill: false },
    outDir: OUT_DIR,
    sourcemap: 'hidden',
  },
  server: {
    // Must match DEV_SANDBOX_PORT in @dotli/config.
    port: 4322,
    strictPort: true,
    headers: {
      'Service-Worker-Allowed': '/',
      'Access-Control-Allow-Origin': '*',
      // As nginx sends, so a product breaks under dev exactly as it would deployed.
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
      'Cross-Origin-Opener-Policy': 'same-origin',
    },
  },
});
