// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Preview } from 'storybook-solidjs-vite';
import '../src/global.css';

const preview: Preview = {
  parameters: {
    // The building blocks first, then what the app's domain composes from them. Storybook reads the order from this
    // file's source, so it stays here.
    options: { storySort: { order: ['Primitives', 'Entities', '*'] } },
  },
};

export default preview;
