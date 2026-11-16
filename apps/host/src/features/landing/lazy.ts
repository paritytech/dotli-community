// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Lazy entry points, each its own chunk, so the page boot leaves them out.

import type * as LandingSettingsContentNamespace from './LandingSettingsContent.js';

/** The landing page's settings view. Rejects when its chunk fails to load. */
export function loadLandingSettingsContent(): Promise<typeof LandingSettingsContentNamespace> {
  return import('./LandingSettingsContent.js');
}
