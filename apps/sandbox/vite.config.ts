// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { sentryVitePlugin } from '@sentry/vite-plugin';
import { defineConfig, build as viteBuild, type Plugin, type PluginOption } from 'vite';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import solid from '@solidjs/vite-plugin';
import wasmPlugin from 'vite-plugin-wasm';
import {
  appBuildOptions,
  rolldownOptions,
  buildInfo,
  runtimeNetworkConfigScript,
  socialMetaTags,
} from '@dotli/config/vite';
import { stripAnalytics } from '@dotli/metrics/vite';

// vite-plugin-wasm types its ESM entry with CommonJS-style declarations, so
// NodeNext sees the module object. At runtime the default export is the plugin.
const wasm = wasmPlugin as unknown as () => Plugin;

// Mirror the host's behavior: fall back to git HEAD when CI didn't inject
// `VITE_COMMIT_SHA`, so the SW's baked `__SW_VERSION__` is a real commit in
// dev builds too.
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

const OUT_DIR = 'dist';
const APP_URL = process.env['VITE_APP_URL'] ?? '';

/**
 * Sentry sourcemap upload, skipped when metrics are off (runtime SDK is aliased to a
 * no-op, nothing to attribute) and locally without SENTRY_AUTH_TOKEN
 * (preserves source maps for debugging).
 */
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
    release: process.env['VITE_COMMIT_SHA'] !== undefined ? { name: process.env['VITE_COMMIT_SHA'] } : {},
    sourcemaps: { filesToDeleteAfterUpload: ['./dist/**/*.map'] },
  });
}

/**
 * Build the Service Worker as a self-contained ES module bundle.
 */
function buildServiceWorker(): Plugin {
  return {
    name: 'build-service-worker',
    apply: 'build',
    async closeBundle() {
      // Stamp the SW bundle with the commit SHA (falls back to a dev marker).
      // The page checks this at runtime to detect a stale SW and force an
      // update (see `apps/sandbox/src/main.ts` registerAppServiceWorker).
      // Using `define` guarantees the SHA is inlined as a literal, so the SW
      // bytes actually change between releases (otherwise the browser might
      // skip updating a byte-identical script).
      const swVersion = process.env['VITE_COMMIT_SHA'] ?? 'dev';
      // eslint-disable-next-line no-console -- build progress for the terminal.
      console.log(`\nBuilding Service Worker (app-sw) @ ${swVersion}...`);
      await viteBuild({
        configFile: false,
        plugins: [wasm()],
        define: {
          __SW_VERSION__: JSON.stringify(swVersion),
        },
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

/**
 * Vite plugin that injects <link rel="modulepreload"> for critical chunks
 * (fetch/P2P and render) so the browser starts downloading them during
 * HTML parse instead of waiting for the entry module to import() them.
 */
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
    headers: {
      'Service-Worker-Allowed': '/',
      'Access-Control-Allow-Origin': '*',
    },
  },
});
