// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Lazy entry points, each its own chunk, so the page boot leaves them out.

import type * as SettingsContentNamespace from './SettingsContent.js';

/** The settings view. Rejects when its chunk fails to load. */
export function loadSettingsContent(): Promise<typeof SettingsContentNamespace> {
  return import('./SettingsContent.js');
}
