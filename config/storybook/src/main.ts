// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/// <reference types="node" />

import { join } from 'node:path';
import { mergeConfig, type PluginOption } from 'vite';
import type { StorybookConfig } from 'storybook-solidjs-vite';
import { cssModules } from '@config/vite/css-modules';

export interface StorybookMainOptions {
  /**
   * The package's extra Vite plugins. Called once for the page and once for each worker build, since a plugin
   * instance serves one build.
   */
  plugins?: () => PluginOption[];
  /**
   * The Vite config Storybook starts from, instead of the package's own `vite.config.ts`. For an app whose config
   * carries its release build (service worker, uploads), which stories must not run.
   */
  viteConfigPath?: string;
  /** Off for a package that draws its own page, such as the debug panel on its palette. */
  pageFrame?: boolean;
}

/** The Storybook `main` config of a UI package, whose stories sit beside their components in `src`. */
export function storybookMain(options: StorybookMainOptions = {}): StorybookConfig {
  const plugins = options.plugins ?? (() => []);
  return {
    framework:
      options.viteConfigPath === undefined
        ? 'storybook-solidjs-vite'
        : { name: 'storybook-solidjs-vite', options: { builder: { viteConfigPath: options.viteConfigPath } } },
    stories: ['../src/**/*.stories.tsx'],
    addons: ['@storybook/addon-docs', '@storybook/addon-a11y', '@storybook/addon-vitest'],
    // Before the package's own preview, which Storybook applies last.
    previewAnnotations: (entries: string[] = []) => [
      ...entries,
      join(import.meta.dirname, 'preview.tsx'),
      ...(options.pageFrame === false ? [] : [join(import.meta.dirname, 'page-frame.tsx')]),
    ],
    core: { disableTelemetry: true },
    // No Solid plugin here. The framework's viteFinal already adds one, and a second compiles every component twice.
    viteFinal: config =>
      mergeConfig(config, {
        css: { modules: cssModules() },
        plugins: plugins(),
        worker: { plugins },
        define: {
          // getEnabledNetworks() requires VITE_NETWORKS and has no default by design.
          'import.meta.env.VITE_NETWORKS': '"paseo-next-v2,previewnet"',
        },
      }),
  };
}
