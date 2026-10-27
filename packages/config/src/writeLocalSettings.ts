// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { BACKEND_KEY } from './backend.js';
import { CACHE_KEY } from './cacheSettings.js';
import { LEGACY_KEYS } from './getLegacyBackend.js';
import { NETWORK_KEY } from './networkNames.js';
import type { Settings } from './resolveSettings.js';

/** Stores `settings` on this origin, where an old build's keys give way to them. */
export function writeLocalSettings(settings: Settings, local: Pick<Storage, 'setItem' | 'removeItem'>): void {
  local.setItem(NETWORK_KEY, settings.network);
  local.setItem(BACKEND_KEY, settings.backend);
  local.setItem(CACHE_KEY, JSON.stringify(settings.cache));
  for (const key of LEGACY_KEYS) {
    local.removeItem(key);
  }
}
