// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/// <reference types="node" />

import { join } from 'node:path';
import { storybookMain } from '@config/storybook/main';

// The app's vite.config.ts builds the service worker and uploads the release, which a Storybook build must not.
export default storybookMain({ viteConfigPath: join(import.meta.dirname, 'vite.config.ts') });
