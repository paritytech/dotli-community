// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/// <reference types="vite/client" />

// The tokens and base styles the apps load. The shared preview and page frame come from the Storybook config.

import type { Preview } from 'storybook-solidjs-vite';
import '@dotli/ui/styles.css';

const preview: Preview = {
  parameters: {
    // The building blocks first, then what the app's domain composes from them. Storybook reads the order from this
    // file's source, so it stays here.
    options: { storySort: { order: ['Primitives', 'Entities', '*'] } },
  },
};

export default preview;
