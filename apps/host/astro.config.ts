// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The host is a static Astro site: one page (src/pages/index.astro), whose
// shell is plain markup with the reactive pieces as Solid islands
// (@config/astro-solid), server-rendered at build time and hydrated. Astro
// drives Vite; the build's Vite setup is under `vite` below.

import { sentryVitePlugin } from '@sentry/vite-plugin';
import { defineConfig } from 'astro/config';
import type { AstroIntegration } from 'astro';
import { build as viteBuild, type Plugin, type PluginOption } from 'vite';
import { readFileSync, readdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import wasmPlugin from 'vite-plugin-wasm';
import astroSolid from '@config/astro-solid';
import { astroPwa } from '@config/vite/astro-pwa';
import { buildInfo, readPackageVersion } from '@config/vite/build-info';
import { appBuildOptions, rolldownOptions } from '@config/vite/build-options';
import { runtimeNetworkConfigScript } from '@config/vite/runtime-network-config';
import { SANDBOX_SCHEMA_VERSION } from '../../packages/config/src/host-sandbox-version.ts';
import { stripAnalytics } from '@dotli/metrics/vite';
import { handleNodeIdentityProxy, IDENTITY_PROXY_PREFIX } from '../../scripts/identity-proxy.ts';
import { receivingWorker } from './receiving-build.ts';

// vite-plugin-wasm types its ESM entry with CommonJS-style declarations, so
// NodeNext sees the module object. At runtime the default export is the plugin.
const wasm = wasmPlugin as unknown as () => Plugin;

// Local builds don't get `VITE_COMMIT_SHA` injected by CI. Fall back to the
// git HEAD so Diagnostics shows a real commit identifier in dev too. The
// literal "dev" is only used when we're not in a git checkout at all (e.g. a
// tarball).
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
    // Not a git checkout, so leave it unset. topbar.ts treats that as "dev".
  }
}

const OUT_DIR = 'dist';
const APP_URL = process.env['VITE_APP_URL'] ?? '';
const HOST_UPDATE_SCRIPT = `assets/host-update-${process.env['VITE_COMMIT_SHA'] ?? 'dev'}.js`;

function hostUpdateWorker(): AstroIntegration {
  return {
    name: 'host-update-worker',
    hooks: {
      // Finish before astroPwa generates the importing service worker.
      // A release-specific URL avoids stale HTTP-cached importScripts.
      'astro:build:done': async ({ dir }) => {
        await viteBuild({
          configFile: false,
          define: {
            __HOST_SANDBOX_SCHEMA_VERSION__: JSON.stringify(SANDBOX_SCHEMA_VERSION),
          },
          build: {
            emptyOutDir: false,
            outDir: fileURLToPath(dir),
            lib: {
              entry: resolve(import.meta.dirname, 'src/host-update.ts'),
              formats: ['iife'],
              name: 'DotliHostUpdate',
              fileName: () => HOST_UPDATE_SCRIPT,
            },
            sourcemap: false,
            minify: true,
          },
          logLevel: 'warn',
        });
      },
    },
  };
}

/**
 * Walk every workspace member's `package.json` and collect its direct
 * `dependencies` entries. devDependencies and peerDependencies are ignored, so
 * only what dot.li code actually imports appears in Diagnostics. Returns a map
 * keyed by package name whose value is the set of workspace directories that
 * depend on it.
 */
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

/**
 * The installed version of `name` as the workspace at `wsDir` resolves it:
 * its own `node_modules` first, then each ancestor's up to the repo root,
 * where npm hoists most dependencies.
 */
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
      // Not installed at this level, so try the parent.
    }
    if (dir === REPO_ROOT || dirname(dir) === dir) {
      return undefined;
    }
  }
}

/**
 * For every direct dependency whose name starts with `scope`, resolve the
 * actually-installed version as the depending workspace sees it. Ignores
 * transitive dependencies, which would otherwise balloon the version list to
 * 80+ rows.
 */
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
 * The page's preloads, which Vite writes for an HTML entry and Astro does
 * not, added to the built page:
 * - `<link rel="modulepreload">` for every chunk the page's scripts import
 *   statically, so the browser fetches them in parallel rather than one
 *   import level at a time. The islands load as Astro loads them: each
 *   island element imports its component and renderer when it hydrates.
 * - On subdomain pages, a script that preloads the name resolution chunk
 *   (`resolve`), the first lazy chunk a product load imports.
 *
 * It rewrites index.html, so it runs before astroPwa, whose precache
 * manifest records the page's hash.
 */
function pagePreloads(): AstroIntegration {
  let base = '/';
  /** Each client chunk's static imports, by file name. */
  const imports = new Map<string, readonly string[]>();
  /** The client chunks' file names, by chunk name. */
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

/**
 * Mirror nginx scoping: COEP/COOP/CORP only apply to /__preview, not the
 * whole host build. Applying them server-wide breaks the legacy
 * /localhost:<port> proxy iframe in browsers that enforce COEP, because
 * arbitrary localhost dev servers don't ship CORP/COEP.
 */
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

/**
 * Sentry sourcemap upload. Skipped when metrics are off (runtime SDK is aliased to a
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

export default defineConfig({
  outDir: OUT_DIR,
  base: APP_URL === '' ? '/' : new URL(APP_URL).pathname,
  // Where the Vite build put them: nginx rate-limits and caches /assets/.
  build: { assets: 'assets' },
  integrations: [
    // Compiles Solid for the islands: server-rendered at build time and
    // hydrated in the browser (see config/astro-solid).
    astroSolid(),
    // Before astroPwa: it rewrites the page that the precache manifest hashes.
    pagePreloads(),
    hostUpdateWorker(),
    // Emits the classic receiver and matching WASM before Workbox precaching.
    receivingWorker(),
    // Host shell PWA. Scope-locked to the host origin (myapp.dot.li). The
    // protocol iframe on host.dot.li and the app iframe on *.app.dot.li are
    // cross-origin and outside this SW's reach by design. Compatible host
    // sessions keep prompt-style updates. The imported upgrade worker replaces
    // incompatible cached shells without touching wallet or application storage.
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
        // The TrUAPI core loads its ring-VRF module (~4.6 MB) only when a
        // ring-VRF operation first needs it. Precaching it would make every
        // installed shell download it after each release.
        globIgnores: [
          '**/truapi_provider_bg*.wasm',
          '**/truapi_verifiable_bg*.wasm',
          '**/host-update-*.js',
          'host-receiving.js',
        ],
        cleanupOutdatedCaches: true,
        importScripts: [HOST_UPDATE_SCRIPT, '/host-receiving.js'],
        // The upgrade worker overrides these only for outdated shells;
        // matching-contract sessions still opt into an ordinary update.
        skipWaiting: false,
        clientsClaim: false,
        maximumFileSizeToCacheInBytes: 32 * 1024 * 1024,
        // Bypass the SW for /__preview so nginx's COEP/COOP/CORP headers
        // reach the browser, and for host_version.json so opening it shows
        // the file rather than the cached shell.
        navigateFallbackDenylist: [/^\/__preview(\?|$|\/)/, /^\/host_version\.json$/],
      },
    }),
  ],
  vite: {
    envDir: resolve(import.meta.dirname, '../..'),
    // The host's settings are VITE_*, as under plain Vite (Astro's own
    // default is PUBLIC_*).
    envPrefix: 'VITE_',
    plugins: [
      stripAnalytics(process.env['VITE_METRICS'] !== 'true'),
      wasm(),
      {
        name: 'dotli-identity-proxy',
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url?.startsWith(IDENTITY_PROXY_PREFIX) === true) {
              void handleNodeIdentityProxy(req, res);
            } else {
              next();
            }
          });
        },
        configurePreviewServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url?.startsWith(IDENTITY_PROXY_PREFIX) === true) {
              void handleNodeIdentityProxy(req, res);
            } else {
              next();
            }
          });
        },
      },
      // Serves /dotli-network.js under `astro dev`; the page links it
      // (src/pages/index.astro).
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
      // Baked once at build time, read lazily at the declaration site so a
      // missing package (shouldn't happen given the monorepo overrides)
      // falls back to empty/"unknown" rather than failing the build.
      __DOTLI_VERSION__: JSON.stringify(readPackageVersion(import.meta.dirname)),
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
