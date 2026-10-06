// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/// <reference types="node" />

import { mergeConfig } from 'vite';
import type { StorybookConfig } from 'storybook-solidjs-vite';
import { cssModules } from '@config/vite/css-modules';

const config: StorybookConfig = {
  framework: 'storybook-solidjs-vite',
  stories: ['../src/**/*.stories.tsx'],
  addons: ['@storybook/addon-docs', '@storybook/addon-a11y', '@storybook/addon-vitest'],
  core: { disableTelemetry: true },
  // No Solid plugin here. The framework's viteFinal runs first and adds
  // vite-plugin-solid, which from 3.0 re-exports the repo's @solidjs/vite-plugin,
  // so a second one would compile every component twice.
  viteFinal: config =>
    mergeConfig(config, {
      css: { modules: cssModules() },
      define: {
        // getEnabledNetworks() requires VITE_NETWORKS, as in vitest.config.ts.
        'import.meta.env.VITE_NETWORKS': '"paseo-next-v2,previewnet"',
      },
    }),
};

export default config;
