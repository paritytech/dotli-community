// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Runs every story of the one Storybook as a browser test.

/// <reference types="node" />

import { join } from 'node:path';
import { defineConfig, mergeConfig } from 'vitest/config';
import { storybookTest } from '@storybook/addon-vitest/vitest-plugin';
import { storiesBrowserTest } from '@config/storybook/vitest';

export default mergeConfig(
  storiesBrowserTest,
  defineConfig({ plugins: [storybookTest({ configDir: join(import.meta.dirname, '.storybook') })] }),
);
