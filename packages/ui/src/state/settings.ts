// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import {
  getBackend,
  getCacheSettings,
  isSharedWorkerAvailable,
  isVerifiedSession,
  type Backend,
  type CacheSettings,
} from "@dotli/config/mode";
import {
  getEnabledNetworks,
  getNetwork,
  type Network,
} from "@dotli/config/network";
import { createSyncStore, type ReadableStore } from "./create-store";

export interface SettingsState {
  backend: Backend;
  cache: CacheSettings;
  network: Network;
  enabledNetworks: Network[];
  /** Whether this browser can run the shared-worker light client. */
  sharedWorkerAvailable: boolean;
  /** Whether the backend verifies chain data (isVerifiedSession). */
  verified: boolean;
}

// Null until the host seeds it, so nothing reads localStorage at import time
// or during build-time rendering.
const settings = createSyncStore<SettingsState | null>(null);

export const settingsStore: ReadableStore<SettingsState | null> = settings;
export const getSettingsState = settings.get;

/** Read the persisted settings from the config getters. */
function readSettings(): SettingsState {
  const backend = getBackend();
  return {
    backend,
    cache: getCacheSettings(),
    network: getNetwork(),
    enabledNetworks: getEnabledNetworks(),
    sharedWorkerAvailable: isSharedWorkerAvailable(),
    verified: isVerifiedSession(backend),
  };
}

/**
 * Snapshot the persisted settings. Changes go through the settings popover's
 * apply-and-reload path, so one snapshot per page load is enough.
 */
export function initSettingsStore(): void {
  settings.set(readSettings());
}
