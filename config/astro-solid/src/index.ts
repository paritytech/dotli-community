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
import { getContainerRenderer } from './containerRenderer.ts';
import { PACKAGE_NAME } from './packageName.ts';

type Params = Pick<ViteSolidPluginOptions, 'include' | 'exclude' | 'compiler'>;

type ManifestSource = {
  /** The Astro command, which picks the live dev manifest or the one the client build left. */
  command: string;
  /** Where the client build writes its manifest, the static site's output folder. */
  clientDir: string;
  /** The site's base path, which prefixes the manifest's asset URLs. */
  base: string;
};

type GetViteConfigurationParams = {
  /** The Solid plugin options the integration passes through. */
  options: Params;
  /** Solid libraries that must go through Vite outside the client. */
  solidNoExternal: string[];
  /** Read when the virtual manifest module loads, after Astro has filled it in. */
  manifestSource: ManifestSource;
};

const VIRTUAL_MANIFEST_ID = 'virtual:astro-solid-manifest';
const RESOLVED_VIRTUAL_MANIFEST_ID = '\0' + VIRTUAL_MANIFEST_ID;

// Hands the manifest from the client build to prerendering in the same process. Astro deletes every `.vite` folder
// right after write, so it cannot be read from disk later.
const MANIFEST_REGISTRY_KEY = `${PACKAGE_NAME}:client-manifest`;

/**
 * Returns the Astro integration that adds the Solid renderer and its Vite plugins.
 *
 * Its setup hook rejects when the project's Solid libraries cannot be listed, and a build fails when the client build
 * leaves no manifest.
 */
export default function astroSolid(options: Params = {}): AstroIntegration {
  // Filled in at `astro:config:done`, before dev or build starts.
  const manifestSource: ManifestSource = {
    command: 'dev',
    clientDir: '',
    base: '/',
  };

  return {
    name: PACKAGE_NAME,
    hooks: {
      async 'astro:config:setup'({ command, config, addRenderer, updateConfig }) {
        manifestSource.command = command;
        // Solid libraries must go through Vite outside the client, or Node resolves their `default` condition to
        // browser-only code that crashes prerendering.
        const solidPackages = await crawlFrameworkPkgs({
          root: fileURLToPath(config.root),
          isBuild: false,
          isFrameworkPkgByJson(packageJson: { peerDependencies?: Record<string, string> }) {
            const peers = packageJson.peerDependencies ?? {};
            return 'solid-js' in peers || '@solidjs/web' in peers;
          },
        });

        addRenderer(getContainerRenderer());
        updateConfig({
          vite: getViteConfiguration({ options, solidNoExternal: solidPackages.ssr.noExternal, manifestSource }),
        });
      },
      'astro:config:done'({ config }) {
        // The static build writes the client, and its manifest, to the site's output folder.
        manifestSource.clientDir = fileURLToPath(config.outDir);
        manifestSource.base = config.base;
      },
    },
  };
}

function getViteConfiguration({
  options: { include, exclude, compiler },
  solidNoExternal,
  manifestSource,
}: GetViteConfigurationParams): { plugins: PluginOption[] } {
  const plugins: PluginOption[] = [
    solid({
      ...(include === undefined ? {} : { include }),
      ...(exclude === undefined ? {} : { exclude }),
      ...(compiler === undefined ? {} : { compiler }),
      ssr: true,
    }),
    createConfigEnvironmentPlugin(solidNoExternal, manifestSource),
  ];

  return { plugins };
}

// Per project output, so several builds in one process don't read each other's manifests.
function getManifestRegistryKey(manifestSource: ManifestSource): string {
  return `${MANIFEST_REGISTRY_KEY}:${manifestSource.clientDir}`;
}

function createConfigEnvironmentPlugin(solidNoExternal: string[], manifestSource: ManifestSource): Plugin {
  return {
    name: `${PACKAGE_NAME}:config-environment`,
    configEnvironment(environmentName) {
      if (environmentName === 'client') {
        return {
          // Lazy boundary assets resolve from the manifest in server renders.
          build: { manifest: true },
          optimizeDeps: {
            include: [`${PACKAGE_NAME}/client.js`],
            exclude: [`${PACKAGE_NAME}/server.js`],
          },
        };
      }
      return {
        // The integration goes through Vite, so its virtual manifest module resolves in server renders.
        resolve: { noExternal: [...solidNoExternal, PACKAGE_NAME] },
        optimizeDeps: {
          exclude: [`${PACKAGE_NAME}/server.js`],
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
        `  const manifest = globalThis[Symbol.for(${JSON.stringify(getManifestRegistryKey(manifestSource))})];\n` +
        `  if (manifest == null) return null;\n` +
        `  manifest._base = base;\n` +
        `  return manifest;\n` +
        `}\n`
      );
    },
    writeBundle: {
      sequential: true,
      async handler() {
        // Before Astro deletes the .vite folder. The client build always writes the manifest, as its environment asks
        // for one, so a missing one fails the build.
        if (this.environment.name !== 'client') {
          return;
        }
        const raw = await readFile(join(manifestSource.clientDir, '.vite/manifest.json'), 'utf-8');
        // globalThis declares no symbol keys, and the registry entry is read back untyped.
        (globalThis as Record<symbol, unknown>)[Symbol.for(getManifestRegistryKey(manifestSource))] = JSON.parse(raw);
      },
    },
  };
}
