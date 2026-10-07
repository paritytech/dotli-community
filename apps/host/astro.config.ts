// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { sentryVitePlugin } from '@sentry/vite-plugin';
import { defineConfig } from 'astro/config';
import type { AstroIntegration } from 'astro';
import type { Plugin, PluginOption } from 'vite';
import { readFileSync, readdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import wasmPlugin from 'vite-plugin-wasm';
import astroSolid from '@config/astro-solid';
import { astroLazyCss } from '@config/vite/astro-lazy-css';
import { astroPwa } from '@config/vite/astro-pwa';
import { buildInfo, readReleaseVersion } from '@config/vite/build-info';
import { appBuildOptions, rolldownOptions } from '@config/vite/build-options';
import { cssModules } from '@config/vite/css-modules';
import { runtimeNetworkConfigScript } from '@config/vite/runtime-network-config';
import { provideSentryRelease, sentryUploadRelease } from '@config/vite/sentry-release';
import { stripAnalytics } from '@dotli/metrics/vite';

// Its CommonJS-style declarations make NodeNext see the module object, but at runtime the default export is the plugin.
const wasm = wasmPlugin as unknown as () => Plugin;

// Falls back to git HEAD so local builds show a real commit too.
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
    // Unset reads as "dev".
  }
}

// Before Vite reads the environment, so the SDK reports the release the sourcemaps are uploaded under.
provideSentryRelease(import.meta.dirname);

const OUT_DIR = 'dist';
const APP_URL = process.env['VITE_APP_URL'] ?? '';

/** Direct `dependencies` only, so Diagnostics lists just what dot.li code imports. Maps a package to its dependents. */
function collectWorkspaceDependencies(): Map<string, Set<string>> {
  const deps = new Map<string, Set<string>>();
  const roots = [resolve(import.meta.dirname, '../../apps'), resolve(import.meta.dirname, '../../packages')];
  for (const root of roots) {
    let dirs: string[];
    try {
      dirs = readdirSync(root);
    } catch {
      continue;
    }
    for (const dir of dirs) {
      const wsDir = resolve(root, dir);
      let pkg: { dependencies?: Record<string, string> };
      try {
        pkg = JSON.parse(readFileSync(resolve(wsDir, 'package.json'), 'utf8')) as {
          dependencies?: Record<string, string>;
        };
      } catch {
        continue;
      }
      for (const depName of Object.keys(pkg.dependencies ?? {})) {
        let set = deps.get(depName);
        if (!set) {
          set = new Set<string>();
          deps.set(depName, set);
        }
        set.add(wsDir);
      }
    }
  }
  return deps;
}

const REPO_ROOT = resolve(import.meta.dirname, '../..');

/** Resolves as Node does, from the workspace's own `node_modules` up to the repo root, where npm hoists most. */
function installedVersion(wsDir: string, name: string): string | undefined {
  for (let dir = wsDir; ; dir = dirname(dir)) {
    try {
      const depPkg = JSON.parse(readFileSync(resolve(dir, 'node_modules', name, 'package.json'), 'utf8')) as {
        version?: string;
      };
      if (depPkg.version !== undefined && depPkg.version !== '') {
        return depPkg.version;
      }
      // eslint-disable-next-line no-restricted-syntax -- a missing copy just means an ancestor holds it.
    } catch {
      // Not at this level, so try the parent.
    }
    if (dir === REPO_ROOT || dirname(dir) === dir) {
      return undefined;
    }
  }
}

/** Direct dependencies only, since transitive ones would balloon the list to 80+ rows. */
function collectDirectScopedDeps(scope: string): { name: string; version: string }[] {
  const wsDeps = collectWorkspaceDependencies();
  const result = new Map<string, string>();
  for (const [name, usedBy] of wsDeps) {
    if (!name.startsWith(scope)) {
      continue;
    }
    for (const wsDir of usedBy) {
      const version = installedVersion(wsDir, name);
      if (version !== undefined) {
        result.set(name, version);
        break;
      }
    }
  }
  return [...result].sort(([a], [b]) => a.localeCompare(b)).map(([name, version]) => ({ name, version }));
}

function readLightClientVersion(): string {
  const direct = collectDirectScopedDeps('@parity/truapi-provider');
  return direct.find(p => p.name === '@parity/truapi-provider')?.version ?? 'unknown';
}

function readPolkadotApiVersion(): string {
  const direct = collectDirectScopedDeps('polkadot-api');
  return direct.find(p => p.name === 'polkadot-api')?.version ?? 'unknown';
}

/**
 * The modulepreloads Vite writes for an HTML entry and Astro does not, plus, on subdomain pages, the `resolve` chunk a
 * product load imports first.
 */
function pagePreloads(): AstroIntegration {
  let base = '/';
  const imports = new Map<string, readonly string[]>();
  const byName = new Map<string, string>();
  const graph: Plugin = {
    name: 'page-preloads:graph',
    applyToEnvironment: environment => environment.name === 'client',
    generateBundle(_, bundle) {
      for (const output of Object.values(bundle)) {
        if (output.type === 'chunk') {
          imports.set(output.fileName, output.imports);
          byName.set(output.name, output.fileName);
        }
      }
    },
  };
  return {
    name: 'page-preloads',
    hooks: {
      'astro:config:setup': ({ updateConfig }) => {
        updateConfig({ vite: { plugins: [graph] } });
      },
      'astro:config:done': ({ config }) => {
        base = config.base.endsWith('/') ? config.base : `${config.base}/`;
      },
      'astro:build:done': async ({ dir }) => {
        const page = join(fileURLToPath(dir), 'index.html');
        let html = await readFile(page, 'utf8');

        const strip = (url: string): string => (url.startsWith(base) ? url.slice(base.length) : url);
        const scripts = [...html.matchAll(/<script type="module" src="([^"]+)"/g)].map(m => strip(m[1] ?? ''));
        const preload = new Set<string>();
        const visit = (file: string): void => {
          for (const dependency of imports.get(file) ?? []) {
            if (!preload.has(dependency)) {
              preload.add(dependency);
              visit(dependency);
            }
          }
        };
        for (const file of scripts) {
          visit(file);
        }
        for (const script of scripts) {
          preload.delete(script);
        }
        const links = [...preload].map(file => `<link rel="modulepreload" crossorigin href="${base}${file}">`).join('');

        const resolveChunk = byName.get('resolve');
        const critical =
          resolveChunk === undefined
            ? ''
            : `<script>${[
                '(function(){',
                'var h=location.hostname,l;',
                'if(h==="dot.li"||h==="localhost")return;',
                'if(!h.endsWith(".dot.li")&&!h.endsWith(".localhost"))return;',
                `l=document.createElement("link");l.rel="modulepreload";l.href="${base}${resolveChunk}";document.head.appendChild(l);`,
                '})()',
              ].join('')}</script>`;
        html = html.replace('</head>', `${links}${critical}</head>`);
        await writeFile(page, html);
      },
    },
  };
}

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

export default defineConfig({
  outDir: OUT_DIR,
  base: APP_URL === '' ? '/' : new URL(APP_URL).pathname,
  // nginx rate-limits and caches /assets/.
  build: { assets: 'assets' },
  integrations: [
    astroSolid(),
    // An on-demand chunk's CSS loads with that chunk, not at boot.
    astroLazyCss(),
    // Before astroPwa: it rewrites the page that the precache manifest hashes.
    pagePreloads(),
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
        // Loaded only on demand. Precaching would make every installed shell download them after each release.
        globIgnores: ['**/truapi_provider_bg*.wasm', '**/truapi_verifiable_bg*.wasm'],
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
    envDir: resolve(import.meta.dirname, '../..'),
    // Astro's default is PUBLIC_*.
    envPrefix: 'VITE_',
    plugins: [
      stripAnalytics(process.env['VITE_METRICS'] !== 'true'),
      wasm(),
      // Serves /dotli-network.js under `astro dev`.
      runtimeNetworkConfigScript(),
      buildInfo('host'),
      previewCoepHeaders(),
      sentry(),
    ],
    worker: {
      plugins: () => [stripAnalytics(process.env['VITE_METRICS'] !== 'true')],
      rolldownOptions: rolldownOptions(),
    },
    define: {
      __BUILD_TARGET__: JSON.stringify('host'),
      // A missing package falls back to "unknown" rather than failing the build.
      __DOTLI_VERSION__: JSON.stringify(readReleaseVersion(import.meta.dirname)),
      __LIGHT_CLIENT_VERSION__: JSON.stringify(readLightClientVersion()),
      __POLKADOT_API_VERSION__: JSON.stringify(readPolkadotApiVersion()),
      __POLKADOT_API_VERSIONS__: JSON.stringify(collectDirectScopedDeps('@polkadot-api/')),
      __PARITY_TRUAPI_VERSIONS__: JSON.stringify(collectDirectScopedDeps('@parity/truapi')),
    },
    optimizeDeps: {
      exclude: ['@polkadot-api/wasm-executor'],
    },
    build: {
      ...appBuildOptions(),
      sourcemap: 'hidden',
    },
    server: {
      headers: {
        'Service-Worker-Allowed': '/',
        'Access-Control-Allow-Origin': '*',
      },
    },
  },
});
