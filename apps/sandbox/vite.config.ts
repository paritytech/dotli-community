// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { sentryVitePlugin } from '@sentry/vite-plugin';
import { defineConfig, build as viteBuild, type Plugin, type PluginOption } from 'vite';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import solid from '@solidjs/vite-plugin';
import wasmPlugin from 'vite-plugin-wasm';
import { buildInfo } from '@config/vite/build-info';
import { appBuildOptions, rolldownOptions } from '@config/vite/build-options';
import { cssModules } from '@config/vite/css-modules';
import { runtimeNetworkConfigScript } from '@config/vite/runtime-network-config';
import { socialMetaTags } from '@config/vite/social-meta';
import { provideSentryRelease, sentryUploadRelease } from '@config/vite/sentry-release';
import { stripAnalytics } from '@dotli/metrics/vite';

// Its CommonJS-style declarations make NodeNext see the module object, but at runtime the default export is the plugin.
const wasm = wasmPlugin as unknown as () => Plugin;

// Falls back to git HEAD, as the host does, so the SW's baked version is a real commit in local builds too.
if ((process.env['VITE_COMMIT_SHA'] ?? '') === '') {
  try {
    process.env['VITE_COMMIT_SHA'] = execSync('git rev-parse HEAD', {
      cwd: import.meta.dirname,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    // eslint-disable-next-line no-restricted-syntax -- no git checkout is a normal build, not an error.
  } catch {
    // Not a git checkout, leave unset.
  }
}

// Before Vite reads the environment, so the SDK reports the release the sourcemaps are uploaded under.
provideSentryRelease(import.meta.dirname);

const OUT_DIR = 'dist';
const APP_URL = process.env['VITE_APP_URL'] ?? '';

/** Skipped when metrics are off, since the SDK is a no-op, and locally, which keeps source maps for debugging. */
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

function buildServiceWorker(): Plugin {
  return {
    name: 'build-service-worker',
    apply: 'build',
    async closeBundle() {
      // eslint-disable-next-line no-console -- build progress for the terminal.
      console.log(`\nBuilding Service Worker (app-sw) @ ${process.env['VITE_COMMIT_SHA'] ?? 'dev'}...`);
      // Takes VITE_COMMIT_SHA from the process environment, as the page does.
      await viteBuild({
        configFile: false,
        plugins: [wasm()],
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

/** The fetch and render chunks start downloading during HTML parse, not when the entry imports them. */
function preloadCriticalAssets(): Plugin {
  let resolvedBase = '/';
  return {
    name: 'preload-critical-assets',
    configResolved(config) {
      resolvedBase = config.base;
    },
    transformIndexHtml: {
      order: 'post',
      handler(_html, ctx) {
        if (!ctx.bundle) {
          return [];
        }

        const bundleKeys = Object.keys(ctx.bundle);
        const findChunk = (pattern: RegExp): string | undefined => bundleKeys.find(name => pattern.test(name));

        const fetchChunk = findChunk(/^assets\/fetch-.*\.js$/);
        const renderChunk = findChunk(/^assets\/render-.*\.js$/);

        const chunks = [fetchChunk, renderChunk].filter((c): c is string => c !== undefined);
        if (chunks.length === 0) {
          return [];
        }

        return chunks.map(c => ({
          tag: 'link',
          attrs: { rel: 'modulepreload', href: `${resolvedBase}${c}` },
          injectTo: 'head' as const,
        }));
      },
    },
  };
}

export default defineConfig({
  css: { modules: cssModules() },
  envDir: resolve(import.meta.dirname, '../..'),
  base: APP_URL === '' ? '/' : new URL(APP_URL).pathname,
  plugins: [
    stripAnalytics(process.env['VITE_METRICS'] !== 'true'),
    solid(),
    wasm(),
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
    preloadCriticalAssets(),
    buildServiceWorker(),
    sentry(),
  ],
  worker: {
    plugins: () => [stripAnalytics(process.env['VITE_METRICS'] !== 'true')],
    rolldownOptions: rolldownOptions(),
  },
  define: {
    __BUILD_TARGET__: JSON.stringify('app'),
  },
  optimizeDeps: {},
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
