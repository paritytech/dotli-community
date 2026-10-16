// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The service worker precaches the page Astro writes after the client build, so it is generated at build done.
// @vite-pwa/astro does the same. Switch to it once it supports Astro 7.

import { fileURLToPath } from 'node:url';
import type { AstroIntegration } from 'astro';
import type { Plugin, PluginOption } from 'vite';
import { VitePWA, type VitePluginPWAAPI, type VitePWAOptions } from 'vite-plugin-pwa';

/**
 * The web manifest and service worker for an Astro site. The page links the manifest and registers the worker itself.
 */
export function astroPwa(options: Partial<VitePWAOptions>): AstroIntegration {
  let api: VitePluginPWAAPI | undefined;
  return {
    name: 'dotli-pwa',
    hooks: {
      'astro:config:setup': ({ command, config, updateConfig }) => {
        if (command !== 'build' && command !== 'dev') {
          return;
        }
        // `vite-plugin-pwa:build` would run as the client bundle closes, before the page exists. outDir is Astro's,
        // which the plugin cannot tell from Vite's config.
        const plugins: PluginOption[] = VitePWA({ outDir: fileURLToPath(config.outDir), ...options }).filter(
          plugin =>
            plugin.name !== 'vite-plugin-pwa:build' && (command === 'dev' || plugin.name !== 'vite-plugin-pwa:dev-sw'),
        );
        if (command === 'build') {
          const capture: Plugin = {
            name: 'dotli-pwa:build',
            applyToEnvironment: environment => environment.name === 'client',
            configResolved(config) {
              const pwa: { api?: VitePluginPWAAPI } | undefined = config.plugins.find(
                plugin => plugin.name === 'vite-plugin-pwa',
              );
              api = pwa?.api;
            },
            generateBundle(_, bundle) {
              // Emits the web manifest. The casts bridge Rollup types to Rolldown's, which match at runtime.
              type Args = Parameters<VitePluginPWAAPI['generateBundle']>;
              api?.generateBundle(bundle as unknown as Args[0], this as unknown as Args[1]);
            },
          };
          plugins.push(capture);
        }
        updateConfig({ vite: { plugins } });
      },
      'astro:build:done': async () => {
        if (api !== undefined && !api.disabled) {
          await api.generateSW();
        }
      },
    },
  };
}
