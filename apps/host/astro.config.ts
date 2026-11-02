// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { defineConfig } from 'astro/config';
import { resolve } from 'node:path';
import { DEV_HOST_PORT, DEV_PROTOCOL_PORT } from '@dotli/config';
import { LOCAL_ROOTS } from '@dotli/config/local-roots';
import astroSolid from '@config/astro-solid';
import { createDotliApp } from '@config/vite/app';
import { astroPwa } from '@config/vite/astro-pwa';
import { readReleaseVersion } from '@config/vite/build-info';
import { listDependencyVersions } from '@config/vite/dependency-versions';
import { PROTOCOL_PREFIX } from '@config/vite/serving';
import { spaFallback } from '@config/vite/spa-fallback';
import { truapiSigningWorker } from '@config/vite/truapi-signing-worker';

const app = createDotliApp({ appDir: import.meta.dirname, site: 'host', roots: LOCAL_ROOTS });

// Direct dependencies only, so Diagnostics lists just what dot.li code imports. A missing one reads as "unknown".
const dependencies = listDependencyVersions(resolve(import.meta.dirname, '../..'), [
  'polkadot-api',
  '@polkadot-api/',
  '@parity/truapi',
]);

// The protocol dev server speaks https with the local certificate, which Node does not trust.
const protocolDevServer = { target: `https://localhost:${DEV_PROTOCOL_PORT}`, secure: false };

export default defineConfig({
  // Apart from the preview server's port, so a preview build's precaching service worker never serves this origin.
  server: { port: Number(DEV_HOST_PORT) },
  // Its floating bar covers the phone bar.
  devToolbar: { enabled: false },
  // The dev server refuses cross-site fetches, and Safari counts a product's `*.localhost` and the bare `localhost` as
  // two sites, so without this the signed-in flag and shared settings in the dev store never answer a product page.
  security: { allowedDomains: LOCAL_ROOTS.flatMap(root => [{ hostname: root }, { hostname: `**.${root}` }]) },
  base: app.base,
  // Hashed assets sit under /assets/, which is cached as immutable. `file` writes landing.html and session.html beside
  // index.html, for the servers to pick by host and path.
  build: { assets: 'assets', format: 'file' },
  integrations: [
    astroSolid(),
    // The page registers the worker and prompts for updates itself.
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
        // worker lives on product hosts only, which never show the landing page or the sign-in window.
        // The local wallet's signing worker, its wasm and its core module load only in local mode, and the debug
        // panel and its wire describer only in debug mode.
        globIgnores: [
          '**/truapi_provider_bg*.wasm',
          '**/truapi_verifiable_bg*.wasm',
          'landing.html',
          'session.html',
          '**/truapi_signing_bg*.wasm',
          '**/signingWorker*.js',
          '**/localWalletCore*.js',
          '**/truapiDebugPanel*',
          '**/debugPanelHost*',
          '**/debugWireDescribe*',
        ],
        cleanupOutdatedCaches: true,
        // Prompted updates need the waiting SW to sit idle until the user opts in.
        skipWaiting: false,
        clientsClaim: false,
        maximumFileSizeToCacheInBytes: 32 * 1024 * 1024,
        // /__preview needs the isolation headers the shell's fallback would not carry, and host_version.json must show
        // the file, not the shell.
        navigateFallbackDenylist: [/^\/__preview(\?|$|\/)/, /^\/host_version\.json$/],
      },
    }),
  ],
  vite: app.createViteConfig({
    plugins: [spaFallback({ landing: '/landing', session: '/session' }, app.serving), truapiSigningWorker()],
    worker: {
      plugins: () => [truapiSigningWorker()],
    },
    // Stories and their fixtures are Storybook's, not the app's. A scan that reaches a value import of Storybook's
    // Solid package pulls in its Solid 1 renderer, which Solid 2 cannot resolve, and fails the whole dev pre-bundle.
    optimizeDeps: { entries: ['!src/**/*.stories.tsx', '!src/testing/**'] },
    define: {
      __DOTLI_VERSION__: JSON.stringify(readReleaseVersion(import.meta.dirname)),
      // smoldot is compiled into truapi-provider's wasm, so the provider version identifies the light client.
      __LIGHT_CLIENT_VERSION__: JSON.stringify(readDependencyVersion('@parity/truapi-provider')),
      __POLKADOT_API_VERSION__: JSON.stringify(readDependencyVersion('polkadot-api')),
      __POLKADOT_API_VERSIONS__: JSON.stringify(listScopedDependencies('@polkadot-api/')),
      __PARITY_TRUAPI_VERSIONS__: JSON.stringify(listScopedDependencies('@parity/truapi')),
    },
    // Node would load the workspace sources to render the page, and cannot map their `.js` imports to `.ts` files.
    ssr: { noExternal: [/^@dotli\//] },
    server: {
      // The protocol frame and the dev settings store share the host's origin, so the dev server hands them to the
      // protocol dev server. The protocol path goes there except on a product or sandbox host, where the path is the
      // product's own.
      proxy: {
        [`${PROTOCOL_PREFIX}/`]: { ...protocolDevServer, bypass: app.serving.getProtocolProxyBypass },
        '/__dotli-mode/': protocolDevServer,
      },
      headers: {
        'Service-Worker-Allowed': '/',
        'Access-Control-Allow-Origin': '*',
      },
    },
  }),
});

function readDependencyVersion(name: string): string {
  return dependencies.find(dependency => dependency.name === name)?.version ?? 'unknown';
}

function listScopedDependencies(prefix: string) {
  return dependencies.filter(dependency => dependency.name.startsWith(prefix));
}
