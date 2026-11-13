// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The settings as the panel reads them. The page passes wider values, which fit structurally.

import type { Network, Settings } from '@dotli/config';

/** What is saved, and what this browser allows. */
export type SavedSettings = {
  enabledNetworks: readonly Network[];
  sharedWorkerAvailable: boolean;
  /** Whether the backend verifies chain data. */
  verified: boolean;
} & Settings;

/** Saves `next` over `prior` and reloads the app. A full wipe clears every cache whatever `next` says. */
export type ApplySettings = (next: Settings, prior: Settings, options?: { forceFullWipe?: boolean }) => Promise<void>;

/**
 * Whether a reset runs: `applying` for a save, `clearing` for a full wipe. A reset that started never ends, since the
 * reload follows it.
 */
export type SettingsResetStatus = 'idle' | 'applying' | 'clearing';

/** Returns whether `status` is a running reset, a save or a full wipe. Never throws. */
export function isResetRunning(status: SettingsResetStatus): boolean {
  switch (status) {
    case 'idle':
      return false;
    case 'applying':
    case 'clearing':
      return true;
  }
}
