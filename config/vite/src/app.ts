// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What every app's build shares, as one Vite config each app merges its own over: where `.env` lives, the shared
// plugins, the worker and build options, and the dev servers' isolation headers. Making it fills in the commit and the
// Sentry release, so call it before Vite reads the environment.

import { resolve } from 'node:path';
import { mergeConfig, type Plugin, type UserConfig } from 'vite';
import wasmPlugin from 'vite-plugin-wasm';
import { buildInfo } from './buildInfoPlugin.ts';
import { createAppBuildOptions, createRolldownOptions } from './buildOptions.ts';
import { createDevCertificate } from './createDevCertificate.ts';
import { createLocalServing } from './createLocalServing.ts';
import { cssModules } from './cssModules.ts';
import { provideCommitSha } from './provideCommitSha.ts';
import { runtimeNetworkConfigScript } from './runtimeNetworkConfigPlugin.ts';
import { createSentryUpload, provideSentryRelease } from './sentryRelease.ts';
import { PROTOCOL_PREFIX, type Site } from './siteRoutes.ts';

export type DotliApp = ReturnType<typeof createDotliApp>;

type Params = {
  /** The app's folder, two levels under the repo root. */
  appDir: string;
  /** The build the app is. */
  site: Site;
  /** The local roots the app's dev and preview servers answer under. */
  roots: readonly string[];
};

// Its CommonJS-style declarations make NodeNext see the module object, but at runtime the default export is the plugin.
const wasm = wasmPlugin as unknown as () => Plugin;

/**
 * Returns the shared build of the app in `appDir`, which serves `site` under the local roots `roots` when run locally.
 * Sets `VITE_COMMIT_SHA` and `VITE_SENTRY_RELEASE` when it can. Throws when `VITE_APP_URL` is set but is not a URL.
 */
export function createDotliApp({ appDir, site, roots }: Params) {
  const serving = createLocalServing(roots);
  provideCommitSha(appDir);
  // The upload falls back to the commit when no tag names the release.
  const release = provideSentryRelease(appDir) ?? process.env['VITE_COMMIT_SHA'];
  const appUrl = process.env['VITE_APP_URL'] ?? '';
  const envDir = resolve(appDir, '../..');
  const shared: UserConfig = {
    envDir,
    // Astro's default is PUBLIC_*.
    envPrefix: 'VITE_',
    // Strips the Sentry SDK's debug logger from the bundle.
    define: { __SENTRY_DEBUG__: false },
    css: { modules: cssModules() },
    // The isolation headers run ahead of an app's own plugins, so they read a request's path before any of those
    // plugins rewrites it.
    plugins: [
      wasm(),
      runtimeNetworkConfigScript(),
      buildInfo(site),
      serving.isolationHeaders(),
      createDevCertificate(roots),
    ],
    worker: { rolldownOptions: createRolldownOptions() },
    build: {
      ...createAppBuildOptions(),
      target: 'esnext',
      modulePreload: { polyfill: false },
      sourcemap: 'hidden',
    },
    server: {
      // Each origin has its own fixed dev port, which a busy port must fail rather than move off.
      strictPort: true,
      // Vite trusts only `localhost` by name, and refuses the hot reload socket on any other local root.
      allowedHosts: roots.map(root => `.${root}`),
    },
  };

  function createViteConfig(own: UserConfig): UserConfig {
    const merged: UserConfig = mergeConfig(shared, own);
    return { ...merged, plugins: [...(merged.plugins ?? []), createSentryUpload(release, envDir)] };
  }

  return {
    /** The routes and headers of the local roots the app was made for. */
    serving,
    /** The path the app is served under: `/p/` for the protocol app, else from `VITE_APP_URL`. */
    base: getBase(site, appUrl),
    /** Returns the wasm plugin, for a worker build that lists its own plugins. */
    wasm,
    /**
     * Returns the app's Vite config: the shared one with `own` merged over it, and the Sentry upload last, as its plugin
     * asks. Never throws.
     */
    createViteConfig,
  };
}

function getBase(site: Site, appUrl: string): string {
  if (site === 'protocol') {
    return `${PROTOCOL_PREFIX}/`;
  }
  if (appUrl === '') {
    return '/';
  }
  return new URL(appUrl).pathname;
}
