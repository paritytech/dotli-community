// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { defineConfig } from 'astro/config';
import type { Plugin } from 'vite';
import { resolve } from 'node:path';
import astroSolid from '@config/astro-solid';
import { dotliApp } from '@config/vite/app';
import { astroPwa } from '@config/vite/astro-pwa';
import { buildInfo, readReleaseVersion } from '@config/vite/build-info';
import { appBuildOptions, rolldownOptions } from '@config/vite/build-options';
import { cssModules } from '@config/vite/css-modules';
import { dependencyVersions } from '@config/vite/dependency-versions';
import { runtimeNetworkConfigScript } from '@config/vite/runtime-network-config';
import { spaFallback } from '@config/vite/spa-fallback';
import { truapiSigningWorker } from '@config/vite/truapi-signing-worker';
import { stripAnalytics } from '@dotli/metrics/vite';

const app = dotliApp(import.meta.dirname);

const OUT_DIR = 'dist';

// Direct dependencies only, so Diagnostics lists just what dot.li code imports. A missing one reads as "unknown".
const dependencies = dependencyVersions(resolve(import.meta.dirname, '../..'), [
  'polkadot-api',
  '@polkadot-api/',
  '@parity/truapi',
]);
const versionOf = (name: string): string => dependencies.find(dep => dep.name === name)?.version ?? 'unknown';
const scoped = (prefix: string) => dependencies.filter(dep => dep.name.startsWith(prefix));

/** Scoped to /__preview as in nginx, since localhost dev servers ship no CORP/COEP and server-wide COEP breaks them. */
function previewCoepHeaders(): Plugin {
  return {
    name: 'preview-coep-headers',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.startsWith('/__preview') === true) {
          res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
          res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
          res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
        }
        next();
      });
    },
  };
}

export default defineConfig({
  outDir: OUT_DIR,
  // Apart from the preview server's 5173, so a preview build's precaching service worker never serves this origin.
  server: { port: 4321 },
  // Its floating bar covers the phone bar.
  devToolbar: { enabled: false },
  base: app.base,
  // nginx rate-limits and caches /assets/. `file` writes landing.html beside index.html, for the servers to pick by host.
  build: { assets: 'assets', format: 'file' },
  integrations: [
    astroSolid(),
    // src/pwa.ts prompts for updates.
    astroPwa({
      injectRegister: false,
      registerType: 'prompt',
      filename: 'host-sw.js',
      manifest: {
        name: 'Polkadot Web',
        short_name: 'Polkadot Web',
        description: 'Decentralized web browser for Polkadot',
        theme_color: '#000000',
        background_color: '#000000',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: '/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,wasm}'],
        // Loaded only on demand. Precaching would make every installed shell download them after each release. The
        // worker lives on product hosts only, which never show the landing page.
        // The local wallet's signing worker, its wasm and its core module load only in local mode.
        globIgnores: [
          '**/truapi_provider_bg*.wasm',
          '**/truapi_verifiable_bg*.wasm',
          'landing.html',
          '**/truapi_signing_bg*.wasm',
          '**/signing-worker*.js',
          '**/local-wallet-core*.js',
        ],
        cleanupOutdatedCaches: true,
        // Prompted updates need the waiting SW to sit idle until the user opts in.
        skipWaiting: false,
        clientsClaim: false,
        maximumFileSizeToCacheInBytes: 32 * 1024 * 1024,
        // /__preview needs nginx's COEP/COOP/CORP headers, and host_version.json must show the file, not the shell.
        navigateFallbackDenylist: [/^\/__preview(\?|$|\/)/, /^\/host_version\.json$/],
      },
    }),
  ],
  vite: {
    css: { modules: cssModules() },
    envDir: app.envDir,
    // Astro's default is PUBLIC_*.
    envPrefix: 'VITE_',
    plugins: [
      stripAnalytics(process.env['VITE_METRICS'] !== 'true'),
      app.wasm(),
      // Serves /dotli-network.js under `astro dev`.
      runtimeNetworkConfigScript(),
      buildInfo('host'),
      previewCoepHeaders(),
      // After previewCoepHeaders, which needs the `/__preview` path this rewrites to `/`.
      spaFallback({ landing: '/landing' }),
      app.sentry(),
      truapiSigningWorker(),
    ],
    worker: {
      plugins: () => [stripAnalytics(process.env['VITE_METRICS'] !== 'true'), truapiSigningWorker()],
      rolldownOptions: rolldownOptions(),
    },
    define: {
      __DOTLI_VERSION__: JSON.stringify(readReleaseVersion(import.meta.dirname)),
      // smoldot is compiled into truapi-provider's wasm, so the provider version identifies the light client.
      __LIGHT_CLIENT_VERSION__: JSON.stringify(versionOf('@parity/truapi-provider')),
      __POLKADOT_API_VERSION__: JSON.stringify(versionOf('polkadot-api')),
      __POLKADOT_API_VERSIONS__: JSON.stringify(scoped('@polkadot-api/')),
      __PARITY_TRUAPI_VERSIONS__: JSON.stringify(scoped('@parity/truapi')),
    },
    optimizeDeps: {
      exclude: ['@polkadot-api/wasm-executor'],
    },
    // Node would load the workspace sources to render the page, and cannot map their `.js` imports to `.ts` files.
    ssr: { noExternal: [/^@dotli\//] },
    build: {
      ...appBuildOptions(),
      sourcemap: 'hidden',
    },
    server: {
      // The sandbox and protocol dev servers take the next ports, so this one must not drift onto them.
      strictPort: true,
      headers: {
        'Service-Worker-Allowed': '/',
        'Access-Control-Allow-Origin': '*',
      },
    },
  },
});
