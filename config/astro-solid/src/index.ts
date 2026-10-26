// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Astro integration for Solid 2. Hands the client build's asset manifest to server renders, so lazy() boundaries
// inside islands resolve their modules.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import solid, { type Options as ViteSolidPluginOptions } from '@solidjs/vite-plugin';
import type { AstroIntegration } from 'astro';
import type { Plugin, PluginOption } from 'vite';
import { crawlFrameworkPkgs } from 'vitefu';
import { getContainerRenderer } from './container-renderer.ts';

type Options = Pick<ViteSolidPluginOptions, 'include' | 'exclude' | 'compiler'>;

type ManifestSource = {
  command: string;
  /** Where the client build writes its manifest, the static site's output folder. */
  clientDir: string;
  base: string;
};

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
    clientDir: '',
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
      'astro:config:done': ({ config }) => {
        // The static build writes the client, and its manifest, to the site's output folder.
        manifestSource.clientDir = fileURLToPath(config.outDir);
        manifestSource.base = config.base;
      },
    },
  };
}

const VIRTUAL_MANIFEST_ID = 'virtual:astro-solid-manifest';
const RESOLVED_VIRTUAL_MANIFEST_ID = '\0' + VIRTUAL_MANIFEST_ID;

// Hands the manifest from the client build to prerendering in the same process. Astro deletes every `.vite` folder
// right after write, so it cannot be read from disk later.
const MANIFEST_REGISTRY_KEY = `${PACKAGE}:client-manifest`;

// Per project output, so several builds in one process don't read each other's manifests.
function manifestRegistryKey(manifestSource: ManifestSource): string {
  return `${MANIFEST_REGISTRY_KEY}:${manifestSource.clientDir}`;
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
      // Build: prerendering runs in this process after the client build, which left its manifest in the registry.
      return (
        `const base = ${JSON.stringify(manifestSource.base)};\n` +
        `export function loadManifest() {\n` +
        `  const manifest = globalThis[Symbol.for(${JSON.stringify(manifestRegistryKey(manifestSource))})];\n` +
        `  if (manifest == null) return null;\n` +
        `  manifest._base = base;\n` +
        `  return manifest;\n` +
        `}\n`
      );
    },
    writeBundle: {
      sequential: true,
      async handler() {
        // Before Astro's `astro:ssr-assets` plugin deletes the .vite folder. The client build always writes the
        // manifest, as its environment asks for one, so a missing one fails the build.
        if (this.environment.name !== 'client') {
          return;
        }
        const raw = await readFile(join(manifestSource.clientDir, '.vite/manifest.json'), 'utf-8');
        (globalThis as Record<symbol, unknown>)[Symbol.for(manifestRegistryKey(manifestSource))] = JSON.parse(raw);
      },
    },
  };
}
