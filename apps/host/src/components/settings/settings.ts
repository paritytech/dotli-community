// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The settings as the panel reads them. The page passes wider values, which fit structurally.

import type { Backend, CacheSettings, Network } from '@dotli/config';

/** What is saved, and what this browser allows. */
export interface SavedSettings {
  backend: Backend;
  cache: CacheSettings;
  network: Network;
  enabledNetworks: readonly Network[];
  sharedWorkerAvailable: boolean;
  /** Whether the backend verifies chain data. */
  verified: boolean;
}

/** Network and cache changes, kept until Save and apply. */
export interface SettingsDraft {
  chain: Backend;
  network: Network;
  cache: CacheSettings;
}

/** Saves `draft` over `prior` and reloads the app. A full wipe clears every cache whatever the draft says. */
export type ApplySettings = (
  draft: SettingsDraft,
  prior: SettingsDraft,
  options?: { forceFullWipe?: boolean },
) => Promise<void>;
