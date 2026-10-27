// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { BACKEND_KEY } from './backend.js';
import { CACHE_KEY } from './cacheSettings.js';
import { NETWORK_KEY } from './networkNames.js';

/** Whether this origin holds a choice from an earlier visit. Read it before the boot stores this visit's. */
export function hasStoredSettings(local: Pick<Storage, 'getItem'>): boolean {
  return [NETWORK_KEY, BACKEND_KEY, CACHE_KEY].some(key => local.getItem(key) !== null);
}
