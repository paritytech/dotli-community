// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Imports no Solid, so the spec runs under Node.

import { pageLocalStorage } from '@dotli/shared';
import { createPersistentAtom } from '@dotli/stores-persistent';
import type { PanelStorage } from './panelStorage.js';

export type DockPosition = 'bottom' | 'right';

type DockStorage = ReturnType<typeof createDockStorage>;

type Params = {
  /** Where the dock is kept. */
  storage?: PanelStorage;
};

const DOCK_STORAGE_KEY = 'truapi-debug:dock';

const DOCK_POSITIONS: readonly DockPosition[] = ['bottom', 'right'];

/**
 * The panel's dock, kept in `storage` from one mount to the next. Bottom when nothing there parses, and docking back
 * to the bottom removes the key. Never throws.
 */
export function createDockStorage({ storage = pageLocalStorage }: Params = {}) {
  return createPersistentAtom<DockPosition>({
    key: DOCK_STORAGE_KEY,
    storage,
    initial: 'bottom',
    decode: decodeDock,
    // The key holds the bare name, not JSON, so a dock stored by an earlier build still reads.
    encode: value => value,
  });
}

// Built on first use, so importing the module reads no storage.
let page: DockStorage | undefined;

/** The page's dock, in the page's local storage, the same atom on every call. Never throws. */
export function getDockStorage(): DockStorage {
  page ??= createDockStorage();
  return page;
}

function decodeDock(raw: string): DockPosition | undefined {
  return DOCK_POSITIONS.find(dock => dock === raw);
}
