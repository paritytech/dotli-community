// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { BACKEND_KEY, backendRunnable, isSharedWorkerAvailable, migrateLegacyOn, modeStorage } from './mode.js';
import { NETWORK_KEY, defaultNetwork, storedNetwork } from './network.js';

/**
 * Stores what the setting reads fall back to, so a fresh origin keeps its defaults, an old build's keys move to the
 * backend key and a backend this browser cannot run is replaced. Call once at boot, before the shared mode store
 * hydrates: it seeds from per-origin storage, which must already hold these values for a shared value to keep
 * precedence and a fresh origin to mirror its default up.
 */
export function persistDefaults(sharedWorkerAvailable: boolean = isSharedWorkerAvailable()): void {
  const storage = modeStorage();
  migrateLegacyOn(storage);
  const backend = backendRunnable(sharedWorkerAvailable);
  if (storage.getItem(BACKEND_KEY) !== backend) {
    storage.setItem(BACKEND_KEY, backend);
  }
  // The stored choice, not `getNetwork`, which a context's override would answer.
  const network = storedNetwork() ?? defaultNetwork();
  if (storage.getItem(NETWORK_KEY) !== network) {
    storage.setItem(NETWORK_KEY, network);
  }
}
