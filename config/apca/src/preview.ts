// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The addon's preview entry. Storybook merges its annotations into every story's.

import { axeConfig } from './axeConfig.js';

/** The a11y addon's axe settings, with the APCA rule in place of WCAG `color-contrast`. */
export const parameters = {
  a11y: { config: axeConfig },
};
