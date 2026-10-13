// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// This context's settings. The host's boot sets them, and the protocol frame and the sandbox set the network their URL
// names. A settings change reloads the page, so nothing sets them after boot.

import type { Settings } from './settings.js';

let current: Settings | null = null;

/** Null until boot sets them, when each reader takes its default. */
export function activeSettings(): Settings | null {
  return current;
}

/** Returns a function that puts the previous settings back, for tests. */
export function setSettings(next: Settings): () => void {
  const previous = current;
  current = next;
  return () => {
    current = previous;
  };
}
