// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Astro integration for Solid 2. Hands the client build's asset manifest to server renders, so lazy() boundaries
// inside islands resolve their modules.

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import solid, { type Options as ViteSolidPluginOptions } from '@solidjs/vite-plugin';
import type { AstroIntegration } from 'astro';
import type { Plugin, PluginOption } from 'vite';
import { crawlFrameworkPkgs } from 'vitefu';
import { getContainerRenderer } from './container-renderer.ts';

export type Options = Pick<ViteSolidPluginOptions, 'include' | 'exclude' | 'compiler'>;

export interface ManifestSource {
  command: string;
  clientDirs: string[];
  serverDir: string | null;
  base: string;
}

const PACKAGE = '@config/astro-solid';

function getViteConfiguration(
  { include, exclude, compiler }: Options,
  solidNoExternal: string[],
  manifestSource: ManifestSource,
): { plugins: PluginOption[] } {
  const plugins: PluginOption[] = [
    solid({
      ...(include === undefined ? {} : { include }),
      ...(exclude === undefined ? {} : { exclude }),
      ...(compiler === undefined ? {} : { compiler }),
      ssr: true,
    }),
    configEnvironmentPlugin(solidNoExternal, manifestSource),
  ];

  return { plugins };
}

export default function astroSolid(options: Options = {}): AstroIntegration {
  // Filled in at `astro:config:done`, before dev or build starts.
  const manifestSource: ManifestSource = {
    command: 'dev',
    clientDirs: [],
    serverDir: null,
    base: '/',
  };

  return {
    name: PACKAGE,
    hooks: {
      'astro:config:setup': async ({ command, config, addRenderer, updateConfig }) => {
        manifestSource.command = command;
        // Solid libraries must go through Vite outside the client, or Node resolves their `default` condition to
        // browser-only code that crashes prerendering.
        const solidPackages = await crawlFrameworkPkgs({
          root: fileURLToPath(config.root),
          isBuild: false,
          isFrameworkPkgByJson(pkgJson: { peerDependencies?: Record<string, string> }) {
            const peers = pkgJson.peerDependencies ?? {};
            return 'solid-js' in peers || '@solidjs/web' in peers;
          },
        });

        addRenderer(getContainerRenderer());
        updateConfig({
          vite: getViteConfiguration(options, solidPackages.ssr.noExternal, manifestSource),
        });
      },
      'astro:config:done': ({ logger, config }) => {
        // The client manifest lands in `build.client` for server output and in `outDir` for static. Both are probed.
        manifestSource.clientDirs = [...new Set([fileURLToPath(config.build.client), fileURLToPath(config.outDir)])];
        manifestSource.serverDir = config.output === 'server' ? fileURLToPath(config.build.server) : null;
        manifestSource.base = config.base;
        const knownJsxRenderers = ['@astrojs/react', '@astrojs/preact', '@astrojs/solid-js', PACKAGE];
        const enabledKnownJsxRenderers = config.integrations.filter(renderer =>
          knownJsxRenderers.includes(renderer.name),
        );

        if (enabledKnownJsxRenderers.length > 1 && options.include === undefined && options.exclude === undefined) {
          logger.warn(
            'More than one JSX renderer is enabled. This will lead to unexpected behavior unless you set the `include` or `exclude` option. See https://docs.astro.build/en/guides/integrations-guide/solid-js/#combining-multiple-jsx-frameworks for more information.',
          );
        }
      },
    },
  };
}

const VIRTUAL_MANIFEST_ID = 'virtual:astro-solid-manifest';
const RESOLVED_VIRTUAL_MANIFEST_ID = '\0' + VIRTUAL_MANIFEST_ID;

// Hands the manifest from the client build to prerendering in the same process. Astro deletes every `.vite` folder
// right after write, so it cannot be read from disk later.
const MANIFEST_REGISTRY_KEY = `${PACKAGE}:client-manifest`;
const PERSISTED_MANIFEST_NAME = 'solid-manifest.json';

// Per project output, so several builds in one process don't read each other's manifests.
function manifestRegistryKey(manifestSource: ManifestSource): string {
  return `${MANIFEST_REGISTRY_KEY}:${manifestSource.clientDirs[0] ?? ''}`;
}

function configEnvironmentPlugin(solidNoExternal: string[], manifestSource: ManifestSource): Plugin {
  return {
    name: `${PACKAGE}:config-environment`,
    configEnvironment(environmentName) {
      if (environmentName === 'client') {
        return {
          // The server render resolves lazy boundary assets from it.
          build: { manifest: true },
          optimizeDeps: {
            include: [`${PACKAGE}/client.js`],
            exclude: [`${PACKAGE}/server.js`],
          },
        };
      }
      return {
        // The integration goes through Vite so `virtual:astro-solid-manifest` resolves inside server.ts.
        resolve: { noExternal: [...solidNoExternal, PACKAGE] },
        optimizeDeps: {
          exclude: [`${PACKAGE}/server.js`],
        },
      };
    },
    resolveId(id) {
      return id === VIRTUAL_MANIFEST_ID ? RESOLVED_VIRTUAL_MANIFEST_ID : undefined;
    },
    load(id) {
      if (id !== RESOLVED_VIRTUAL_MANIFEST_ID) {
        return undefined;
      }
      if (manifestSource.command !== 'build') {
        // Dev: @solidjs/vite-plugin's live resolver, which renderToStream accepts directly.
        return `import manifest from 'virtual:solid-manifest';\nexport function loadManifest() { return manifest; }\n`;
      }
      // Build: the server bundles exist before the manifest, so it is resolved at render time. Prerendering finds it
      // in the in-process registry, a deployed server reads the persisted copy.
      const fileCandidates = [
        ...(manifestSource.serverDir === null
          ? []
          : [JSON.stringify(manifestSource.serverDir + PERSISTED_MANIFEST_NAME)]),
        `new URL(${JSON.stringify('./' + PERSISTED_MANIFEST_NAME)}, import.meta.url)`,
        `new URL(${JSON.stringify('../' + PERSISTED_MANIFEST_NAME)}, import.meta.url)`,
      ];
      return (
        `import { readFileSync } from 'node:fs';\n` +
        `const base = ${JSON.stringify(manifestSource.base)};\n` +
        `let manifest;\n` +
        `export function loadManifest() {\n` +
        `  if (manifest !== undefined) return manifest;\n` +
        `  manifest = globalThis[Symbol.for(${JSON.stringify(manifestRegistryKey(manifestSource))})];\n` +
        `  if (manifest === undefined) {\n` +
        `    for (const candidate of [${fileCandidates.join(', ')}]) {\n` +
        `      try {\n` +
        `        manifest = JSON.parse(readFileSync(candidate, 'utf-8'));\n` +
        `        break;\n` +
        `      } catch {}\n` +
        `    }\n` +
        `  }\n` +
        `  if (manifest == null) return (manifest = null);\n` +
        `  manifest._base = base;\n` +
        `  return manifest;\n` +
        `}\n`
      );
    },
    writeBundle: {
      sequential: true,
      async handler() {
        // Before Astro's `astro:ssr-assets` plugin deletes the .vite folder.
        if (this.environment.name !== 'client') {
          return;
        }
        for (const dir of manifestSource.clientDirs) {
          let raw: string;
          try {
            raw = await readFile(join(dir, '.vite/manifest.json'), 'utf-8');
          } catch {
            continue;
          }
          (globalThis as Record<symbol, unknown>)[Symbol.for(manifestRegistryKey(manifestSource))] = JSON.parse(raw);
          if (manifestSource.serverDir !== null) {
            // For deployed SSR runtimes. Next to the server bundle, so it is not publicly served.
            await writeFile(join(manifestSource.serverDir, PERSISTED_MANIFEST_NAME), raw);
          }
          return;
        }
      },
    },
  };
}
