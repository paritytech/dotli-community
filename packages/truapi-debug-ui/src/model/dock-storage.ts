// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Imports no Solid, so the spec runs under Node.

import { pageLocalStorage } from '@dotli/shared';
import type { PanelStorage } from './section-storage.js';

export type DockPosition = 'bottom' | 'right';

const DOCK_STORAGE_KEY = 'truapi-debug:dock';

/** The stored dock, or bottom. */
export function readStoredDock(storage: PanelStorage = pageLocalStorage): DockPosition {
  return storage.getItem(DOCK_STORAGE_KEY) === 'right' ? 'right' : 'bottom';
}

export function writeStoredDock(dock: DockPosition, storage: PanelStorage = pageLocalStorage): void {
  storage.setItem(DOCK_STORAGE_KEY, dock);
}
