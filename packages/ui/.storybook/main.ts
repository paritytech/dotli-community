// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/// <reference types="node" />

import { mergeConfig } from 'vite';
import type { StorybookConfig } from 'storybook-solidjs-vite';
import { cssModules } from '@config/vite/css-modules';
import { truapiSigningWorker } from '@config/vite/truapi-signing-worker';

const config: StorybookConfig = {
  framework: 'storybook-solidjs-vite',
  stories: ['../src/**/*.stories.tsx'],
  addons: ['@storybook/addon-docs', '@storybook/addon-a11y', '@storybook/addon-vitest'],
  core: { disableTelemetry: true },
  // No Solid plugin here. The framework's viteFinal already adds one, and a second compiles every component twice.
  viteFinal: config =>
    mergeConfig(config, {
      css: { modules: cssModules() },
      // The local wallet's signing worker imports a marked runtime id only this plugin resolves, as in the host.
      plugins: [truapiSigningWorker()],
      worker: { plugins: () => [truapiSigningWorker()] },
      define: {
        // getEnabledNetworks() requires VITE_NETWORKS, as in vitest.config.ts.
        'import.meta.env.VITE_NETWORKS': '"paseo-next-v2,previewnet"',
      },
    }),
};

export default config;
