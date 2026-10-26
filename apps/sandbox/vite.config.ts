// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { defineConfig } from 'vite';
import solid from '@solidjs/vite-plugin';
import { dotliApp } from '@config/vite/app';
import { inlineScript } from '@config/vite/inline-script';
import { serviceWorker } from '@config/vite/service-worker';
import { socialMetaTags } from '@config/vite/social-meta';
import { LOCAL_ROOTS } from '@dotli/config/local-roots';

const app = dotliApp(import.meta.dirname, 'app', LOCAL_ROOTS);

export default defineConfig(
  app.vite({
    base: app.base,
    plugins: [
      inlineScript(),
      solid(),
      socialMetaTags({
        title: 'Polkadot Web',
        description:
          'A decentralized web browser that runs in your browser. Open any Polkadot app with trustless, client-side resolution and no servers in the loop.',
        siteName: 'Polkadot Web',
        image: '/icon-512.png',
        imageAlt: 'Polkadot logo',
      }),
      // The worker loads wasm.
      serviceWorker({ srcDir: 'src', filename: 'app-sw.ts', plugins: () => [app.wasm()] }),
    ],
    server: {
      // Must match DEV_SANDBOX_PORT in @dotli/config.
      port: 4002,
      headers: { 'Service-Worker-Allowed': '/' },
    },
  }),
);
