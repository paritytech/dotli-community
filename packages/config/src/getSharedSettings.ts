// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Settings, SharedSettings } from './resolveSettings.js';

/** What the cross-subdomain store keeps of `settings`. */
export function getSharedSettings(settings: Settings): SharedSettings {
  return { backend: settings.backend, cache: JSON.stringify(settings.cache) };
}
