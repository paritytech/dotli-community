// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The one Storybook. Its stories sit beside their components in every app and package.

/// <reference types="node" />

import { fileURLToPath } from 'node:url';
import { mergeConfig } from 'vite';
import type { StorybookConfig } from 'storybook-solidjs-vite';
import { cssModules } from '@config/vite/css-modules';
import { inlineScript } from '@config/vite/inline-script';
import { TEST_DEFINES } from '@config/vite/test-defines';

const shared = (entry: string): string => fileURLToPath(import.meta.resolve(`@config/storybook/${entry}`));

// Called once for the page and once for each worker build, since a plugin instance serves one build. The sandbox
// checker stories frame a product page that inlines its script, bundled as the build does.
const plugins = () => [inlineScript()];

const config: StorybookConfig = {
  framework: 'storybook-solidjs-vite',
  stories: ['../apps/*/src/**/*.stories.tsx', '../packages/*/src/**/*.stories.tsx'],
  addons: ['@storybook/addon-docs', '@storybook/addon-a11y', '@storybook/addon-vitest'],
  // Before this folder's preview, which Storybook applies last.
  previewAnnotations: (entries: string[] = []) => [...entries, shared('preview'), shared('page-frame')],
  core: { disableTelemetry: true },
  // No Solid plugin here. The framework's viteFinal already adds one, and a second compiles every component twice.
  viteFinal: config =>
    mergeConfig(config, {
      css: { modules: cssModules() },
      plugins: plugins(),
      worker: { plugins },
      define: { ...TEST_DEFINES },
    }),
};

export default config;
