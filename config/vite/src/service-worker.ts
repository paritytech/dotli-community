// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A hand-written service worker, built by the app's own config so it reads the same `.env`, mode and `define` as the
// page. It lands as one file at the site root with no chunks, since the browser update-checks the worker byte for byte.

import type { Plugin, PluginOption } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { appBuildOptions } from './build-options.ts';

export type ServiceWorkerOptions = {
  /** The worker source's folder, relative to the app root. */
  srcDir: string;
  /** The worker source, such as `app-sw.ts`, served as `app-sw.js`. */
  filename: string;
  /** Plugins the worker's own build needs. Called once, since a plugin instance serves one build. */
  plugins?: () => PluginOption[];
};

// The PWA plugin's inner build sets only target, minify and sourcemap, so the shared minify chain is added here.
const buildOptions: Plugin = {
  name: 'service-worker-build-options',
  config: () => ({ build: appBuildOptions({ codeSplitting: false }) }),
};

/** Builds the worker after the page. The page registers it itself, and dev serves the source as it is. */
export function serviceWorker({ srcDir, filename, plugins }: ServiceWorkerOptions): PluginOption[] {
  return VitePWA({
    strategies: 'injectManifest',
    srcDir,
    filename,
    injectRegister: false,
    manifest: false,
    injectManifest: {
      // An empty injection point skips the precache manifest, which this worker does not use.
      injectionPoint: '',
      rollupFormat: 'es',
      sourcemap: false,
      buildPlugins: { vite: [buildOptions, ...(plugins?.() ?? [])] },
    },
  });
}
