// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Must not import `@dotli/truapi-debug-ui` or `solid-js`, whose components consume it.

import type { PanelStorage } from './section-storage.js';

export type DockPosition = 'bottom' | 'right';

const DOCK_STORAGE_KEY = 'truapi-debug:dock';

/** The stored dock, or bottom. `storage` is a thunk because reading `localStorage` itself may throw. */
export function readStoredDock(storage: () => PanelStorage = () => localStorage): DockPosition {
  try {
    const raw = storage().getItem(DOCK_STORAGE_KEY);
    if (raw === 'right') {
      return 'right';
    }
    // eslint-disable-next-line no-restricted-syntax -- localStorage may throw in Safari private mode; default to bottom dock.
  } catch {
    /* swallow */
  }
  return 'bottom';
}

export function writeStoredDock(dock: DockPosition, storage: () => PanelStorage = () => localStorage): void {
  try {
    storage().setItem(DOCK_STORAGE_KEY, dock);
    // eslint-disable-next-line no-restricted-syntax -- localStorage may throw on quota/private mode; persistence is best-effort.
  } catch {
    /* swallow */
  }
}
