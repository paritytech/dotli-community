// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// This context's settings. The host's boot sets them twice, before and after the shared store answers, and the protocol
// frame and the sandbox set the network their URL names. Readers that render subscribe, as an island can settle before
// boot sets them. A settings change reloads the page, so nothing sets them after boot.

import { createSyncStore } from '@dotli/shared';
import type { Settings } from './settings.js';

const store = createSyncStore<Settings | null>('active-settings', null);

/** Null until boot sets them, when each reader takes its default. */
export function activeSettings(): Settings | null {
  return store.get();
}

/** Calls `listener` after each change to the settings. Returns the function that stops it. */
export function subscribeSettings(listener: () => void): () => void {
  return store.subscribe(listener);
}

/** Returns a function that puts the previous settings back, for tests. */
export function setSettings(next: Settings): () => void {
  const previous = store.get();
  store.set(next);
  return () => {
    store.set(previous);
  };
}
