// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The settings as the panel reads them. The page passes wider values, which fit structurally.

import type { Network, Settings } from '@dotli/config';

/** What is saved, and what this browser allows. */
export interface SavedSettings extends Settings {
  enabledNetworks: readonly Network[];
  sharedWorkerAvailable: boolean;
  /** Whether the backend verifies chain data. */
  verified: boolean;
}

/** Saves `next` over `prior` and reloads the app. A full wipe clears every cache whatever `next` says. */
export type ApplySettings = (next: Settings, prior: Settings, options?: { forceFullWipe?: boolean }) => Promise<void>;
