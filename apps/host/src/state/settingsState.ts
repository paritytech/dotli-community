// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import {
  getBackend,
  getCacheSettings,
  isSharedWorkerAvailable,
  isVerifiedSession,
  type Backend,
  type CacheSettings,
  getEnabledNetworks,
  getNetwork,
  type Network,
} from '@dotli/config';

import { registerAtomReset } from '@dotli/shared';
import { atom, type ReadableAtom } from 'nanostores';

export type SettingsState = {
  backend: Backend;
  cache: CacheSettings;
  network: Network;
  enabledNetworks: Network[];
  sharedWorkerAvailable: boolean;
  /** Whether the backend verifies chain data. */
  verified: boolean;
};

// Null until `init` seeds it, so a build-time render reads no settings.
const settings = atom<SettingsState | null>(null);
registerAtomReset(settings);
const store: ReadableAtom<SettingsState | null> = settings;

/** The settings the page booted with. */
export const settingsState = {
  /** The settings snapshot, or null until `init` seeds it. */
  store,
  /**
   * Seeds the store with what the active settings and this browser say now. Settings change only through
   * apply-and-reload, so one snapshot per page load is enough. Throws if the deployment's enabled networks are unset,
   * unknown or empty, or its runtime network config is malformed.
   */
  init,
};

function init(): void {
  const backend = getBackend();
  settings.set({
    backend,
    cache: getCacheSettings(),
    network: getNetwork(),
    enabledNetworks: getEnabledNetworks(),
    sharedWorkerAvailable: isSharedWorkerAvailable(),
    verified: isVerifiedSession(backend),
  });
}
