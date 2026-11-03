// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Imports no Solid, so the spec runs under Node.

import { pageLocalStorage, registerAtomReset } from '@dotli/shared';
import { createPersistentAtom } from '@dotli/stores-persistent';
import type { PanelStorage } from './panelStorage.js';

export type DockPosition = 'bottom' | 'right';

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
    encode: String,
  });
}

/** The page's dock, in the page's local storage. It reads its key on first start. */
export const dockStorage = createDockStorage();
registerAtomReset(dockStorage);

function decodeDock(raw: string): DockPosition | undefined {
  return DOCK_POSITIONS.find(dock => dock === raw);
}
