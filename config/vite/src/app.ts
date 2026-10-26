// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What every app's build shares, as one Vite config each app merges its own over: where `.env` lives, the shared
// plugins, the worker and build options, and the dev servers' isolation headers. Making it fills in the commit and the
// Sentry release, so call it before Vite reads the environment.

import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { sentryVitePlugin } from '@sentry/vite-plugin';
import { loadEnv, mergeConfig, type Plugin, type PluginOption, type UserConfig } from 'vite';
import mkcert from 'vite-plugin-mkcert';
import wasmPlugin from 'vite-plugin-wasm';
import { buildInfo } from './build-info-plugin.ts';
import { appBuildOptions, rolldownOptions } from './build-options.ts';
import { cssModules } from './css-modules.ts';
import { runtimeNetworkConfigScript } from './runtime-network-config-plugin.ts';
import { provideSentryRelease, sentryUploadRelease } from './sentry-release.ts';
import { createLocalServing, PROTOCOL_PREFIX, type LocalServing, type Site } from './serving.ts';

// Its CommonJS-style declarations make NodeNext see the module object, but at runtime the default export is the plugin.
const wasm = wasmPlugin as unknown as () => Plugin;

export interface DotliApp {
  /** The path the app is served under: `/p/` for the protocol app, else from `VITE_APP_URL`. */
  base: string;
  /** For a worker build that lists its own plugins. */
  wasm: () => Plugin;
  /** The app's Vite config: the shared one with `own` merged over it, and the Sentry upload last, as its plugin asks. */
  vite: (own: UserConfig) => UserConfig;
  /** The routes and headers of the local roots the app was made for, which its own dev plugins take. */
  serving: LocalServing;
}

/** Falls back to git HEAD so local builds show a real commit too. Left unset, it reads as "dev". */
function provideCommitSha(cwd: string): void {
  if ((process.env['VITE_COMMIT_SHA'] ?? '') !== '') {
    return;
  }
  try {
    process.env['VITE_COMMIT_SHA'] = execSync('git rev-parse HEAD', { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
    // eslint-disable-next-line no-restricted-syntax -- no git checkout is a normal build, not an error.
  } catch {
    // Not a git checkout.
  }
}

/** Uploads source maps when metrics are on and a token is set. Otherwise nothing, so local builds keep them. */
function sentryUpload(appDir: string, envDir: string): PluginOption {
  if ((process.env['SENTRY_AUTH_TOKEN'] ?? '') === '') {
    return false;
  }
  const plugins = [
    sentryVitePlugin({
      org: 'paritytech',
      project: 'dotli',
      telemetry: false,
      authToken: process.env['SENTRY_AUTH_TOKEN'],
      release: sentryUploadRelease(appDir),
      sourcemaps: { filesToDeleteAfterUpload: ['./dist/**/*.map'] },
    }),
  ].flat();
  // Decided per build, from the same `.env` files and process env the runtime gate reads.
  return plugins.map(plugin => ({
    ...plugin,
    apply: (_config, { mode }) => loadEnv(mode, envDir, 'VITE_')['VITE_METRICS'] === 'true',
  }));
}

/**
 * A locally trusted certificate for the dev servers, since Safari keeps `Secure` cookies and the session window's
 * opener rule off plain http on any host but localhost. Previews stay on http, as the functional tests load them there.
 */
function devCertificate(roots: readonly string[]): PluginOption {
  // Its own `apply` takes only a command, and 'serve' covers the preview server too.
  const plugin = mkcert({
    hosts: roots.flatMap(root => [root, `*.${root}`, `*.app.${root}`]),
  }) as Plugin;
  return { ...plugin, apply: (_config, { command, isPreview }) => command === 'serve' && isPreview !== true };
}

/** The shared build of the app in `appDir`, which serves `site` under the local roots `roots` when run locally. */
export function dotliApp(appDir: string, site: Site, roots: readonly string[]): DotliApp {
  const serving = createLocalServing(roots);
  provideCommitSha(appDir);
  provideSentryRelease(appDir);
  const appUrl = process.env['VITE_APP_URL'] ?? '';
  const envDir = resolve(appDir, '../..');
  const shared: UserConfig = {
    envDir,
    // Astro's default is PUBLIC_*.
    envPrefix: 'VITE_',
    // Strips the Sentry SDK's debug logger, as its bundler plugin's size options would.
    define: { __SENTRY_DEBUG__: false },
    css: { modules: cssModules() },
    // The isolation headers run ahead of an app's own plugins, so they read `/__preview` before the host's SPA
    // fallback rewrites it.
    plugins: [wasm(), runtimeNetworkConfigScript(), buildInfo(site), serving.isolationHeaders(), devCertificate(roots)],
    worker: { rolldownOptions: rolldownOptions() },
    build: {
      ...appBuildOptions(),
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
  return {
    serving,
    base: site === 'protocol' ? `${PROTOCOL_PREFIX}/` : appUrl === '' ? '/' : new URL(appUrl).pathname,
    wasm,
    vite: own => {
      const merged: UserConfig = mergeConfig(shared, own);
      return { ...merged, plugins: [...(merged.plugins ?? []), sentryUpload(appDir, envDir)] };
    },
  };
}
