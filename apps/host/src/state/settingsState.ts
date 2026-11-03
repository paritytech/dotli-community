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

type Params = {
  /** The snapshot to hold. Defaults to what the active settings and this browser say now. */
  state?: SettingsState;
};

// Null until `init` seeds it, so a build-time render reads no settings.
const settings = atom<SettingsState | null>(null);
registerAtomReset(settings);
const store: ReadableAtom<SettingsState | null> = settings;

/** The settings the page booted with. */
export const settingsState = {
  /** The settings snapshot, or null until `init` seeds it. */
  store,
  /** Returns the settings snapshot, or null until `init` seeds it. Never throws. */
  get,
  /**
   * Seeds the store with `state`, by default read from the active settings and this browser. Settings change only
   * through apply-and-reload, so one snapshot per page load is enough. Throws, when `state` is left out, if the
   * deployment's enabled networks are unset, unknown or empty, or its runtime network config is malformed.
   */
  init,
};

function get(): SettingsState | null {
  return settings.get();
}

function init({ state = readSettings() }: Params = {}): void {
  settings.set(state);
}

/** What the active settings and this browser say now. */
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
