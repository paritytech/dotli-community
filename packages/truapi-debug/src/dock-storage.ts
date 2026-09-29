// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// TrUAPI debug panel dock-position persistence.
//
// Solid-free: consumed by the Solid truapi-debug components in
// `packages/ui/src/components/truapi-debug/`, so it must not import
// `@dotli/ui` or `solid-js`.

export type DockPosition = 'bottom' | 'right';

export const DOCK_STORAGE_KEY = 'truapi-debug:dock';

export function readStoredDock(): DockPosition {
  try {
    const raw = localStorage.getItem(DOCK_STORAGE_KEY);
    if (raw === 'right') {
      return 'right';
    }
    // eslint-disable-next-line no-restricted-syntax -- localStorage may throw in Safari private mode; default to bottom dock.
  } catch {
    /* swallow */
  }
  return 'bottom';
}

export function writeStoredDock(dock: DockPosition): void {
  try {
    localStorage.setItem(DOCK_STORAGE_KEY, dock);
    // eslint-disable-next-line no-restricted-syntax -- localStorage may throw on quota/private mode; persistence is best-effort.
  } catch {
    /* swallow */
  }
}
