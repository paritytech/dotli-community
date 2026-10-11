// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import {
  getBackend,
  getCacheSettings,
  getLocalWalletEnabled,
  isSharedWorkerAvailable,
  isVerifiedSession,
  type Backend,
  type CacheSettings,
  getEnabledNetworks,
  getNetwork,
  SITE_ID,
  type Network,
} from '@dotli/config';

import { createSyncStore, type ReadableStore } from './create-store.js';

export interface SettingsState {
  backend: Backend;
  cache: CacheSettings;
  network: Network;
  localWalletEnabled: boolean;
  enabledNetworks: Network[];
  sharedWorkerAvailable: boolean;
  /** Whether the backend verifies chain data. */
  verified: boolean;
}

// Null until the host seeds it, so nothing reads localStorage at import time or during build-time rendering.
const settings = createSyncStore<SettingsState | null>('settings', null);

export const settingsStore: ReadableStore<SettingsState | null> = settings;
export const getSettingsState = settings.get;

function readSettings(): SettingsState {
  const backend = getBackend();
  return {
    backend,
    cache: getCacheSettings(),
    network: getNetwork(),
    localWalletEnabled: getLocalWalletEnabled(SITE_ID),
    enabledNetworks: getEnabledNetworks(),
    sharedWorkerAvailable: isSharedWorkerAvailable(),
    verified: isVerifiedSession(backend),
  };
}

/** Settings change only through apply-and-reload, so one snapshot per page load is enough. */
export function initSettingsStore(): void {
  settings.set(readSettings());
}
