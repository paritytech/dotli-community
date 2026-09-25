// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import {
  getBackend,
  getCacheSettings,
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
}

// Null until the host seeds it, so nothing reads localStorage at import time
// or during build-time rendering.
const settings = createSyncStore<SettingsState | null>(null);

export const settingsStore: ReadableStore<SettingsState | null> = settings;
export const getSettingsState = settings.get;

/**
 * Snapshot the persisted settings. Changes go through the settings popover's
 * apply-and-reload path, so one snapshot per page load is enough.
 */
export function initSettingsStore(): void {
  settings.set({
    backend: getBackend(),
    cache: getCacheSettings(),
    network: getNetwork(),
    enabledNetworks: getEnabledNetworks(),
  });
}
