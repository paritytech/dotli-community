// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { BACKEND_KEY, type Backend } from './backend.js';

// Read once, migrated and deleted.
const LEGACY_MODE_KEY = 'dotli:mode';
const LEGACY_CONTENT_BACKEND_KEY = 'dotli:content-backend';

/** An old build's keys, read once and removed when the settings are next stored. */
export const LEGACY_KEYS: readonly string[] = [LEGACY_MODE_KEY, LEGACY_CONTENT_BACKEND_KEY];

/** The backend an old build's keys name, or null. */
export function getLegacyBackend(target: Pick<Storage, 'getItem'>): Backend | null {
  const chain = target.getItem(BACKEND_KEY);
  const content = target.getItem(LEGACY_CONTENT_BACKEND_KEY);
  const legacyMode = target.getItem(LEGACY_MODE_KEY);
  if (chain === 'rpc' || content === 'ipfs-gateway') {
    return 'rpc-gateway';
  }
  if (legacyMode === 'p2p-shared-worker' || legacyMode === 'p2p') {
    return 'smoldot-shared-worker';
  }
  if (legacyMode === 'p2p-direct') {
    return 'smoldot-direct';
  }
  if (legacyMode === 'gateway' || legacyMode === 'centralized') {
    return 'rpc-gateway';
  }
  return null;
}
