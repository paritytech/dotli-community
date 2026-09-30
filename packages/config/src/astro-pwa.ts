// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// vite-plugin-pwa under Astro: the host page is written by Astro after the
// client build, so the service worker, whose precache lists that page, is
// generated once the build is done instead of when the client bundle
// closes. Also what @vite-pwa/astro does, but its latest (1.2.0) supports
// Astro up to 5: switch to it once it supports Astro 7.

import type { AstroIntegration } from 'astro';
import type { Plugin, PluginOption } from 'vite';
import { VitePWA, type VitePluginPWAAPI, type VitePWAOptions } from 'vite-plugin-pwa';

/**
 * The PWA (web manifest and service worker) for an Astro site. The page
 * links the manifest itself (`<link rel="manifest">`): nothing edits the
 * HTML Astro writes. Registration stays the app's own (`injectRegister`
 * off).
 */
export function astroPwa(options: Partial<VitePWAOptions>): AstroIntegration {
  let api: VitePluginPWAAPI | undefined;
  return {
    name: 'dotli-pwa',
    hooks: {
      'astro:config:setup': ({ command, updateConfig }) => {
        if (command !== 'build' && command !== 'dev') {
          return;
        }
        // `vite-plugin-pwa:build` would edit the HTML and write the service
        // worker as the client bundle closes, before the page exists.
        const plugins: PluginOption[] = VitePWA(options).filter(
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
              // Emits the web manifest. vite-plugin-pwa types the bundle and
              // context after Rollup's, Vite's Rolldown ones match at runtime.
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
