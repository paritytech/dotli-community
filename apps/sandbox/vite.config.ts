// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { defineConfig } from 'vite';
import solid from '@solidjs/vite-plugin';
import { dotliApp } from '@config/vite/app';
import { buildInfo } from '@config/vite/build-info';
import { appBuildOptions, rolldownOptions } from '@config/vite/build-options';
import { cssModules } from '@config/vite/css-modules';
import { inlineScript } from '@config/vite/inline-script';
import { runtimeNetworkConfigScript } from '@config/vite/runtime-network-config';
import { serviceWorker } from '@config/vite/service-worker';
import { securityHeaders } from '@config/vite/serving';
import { socialMetaTags } from '@config/vite/social-meta';

const app = dotliApp(import.meta.dirname);

const OUT_DIR = 'dist';

export default defineConfig({
  css: { modules: cssModules() },
  envDir: app.envDir,
  base: app.base,
  plugins: [
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
    // The sub-page helper reaches the worker as a classic script's text, and the worker loads wasm.
    serviceWorker({ srcDir: 'src', filename: 'app-sw.ts', plugins: () => [inlineScript(), app.wasm()] }),
    app.sentry(),
  ],
  worker: {
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
    // As nginx sends, so a product breaks under dev exactly as it would deployed.
    headers: { ...securityHeaders('isolated'), 'Service-Worker-Allowed': '/' },
  },
});
