// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Imports no Solid, so the spec runs under Node.

import { pageLocalStorage } from '@dotli/shared';
import type { PanelStorage } from './panelStorage.js';

export type DockPosition = 'bottom' | 'right';

type Params = {
  /** Where the dock is kept. */
  storage?: PanelStorage;
};

const DOCK_STORAGE_KEY = 'truapi-debug:dock';

/** The panel's dock, kept in `storage` from one mount to the next. */
export function createDockStorage({ storage = pageLocalStorage }: Params = {}) {
  return {
    /** The stored dock, or bottom when none is stored. Throws only what `storage` throws. */
    read,
    /** Stores `dock` for the next mount. Throws only what `storage` throws. */
    write,
  };

  function read(): DockPosition {
    return storage.getItem(DOCK_STORAGE_KEY) === 'right' ? 'right' : 'bottom';
  }

  function write(dock: DockPosition): void {
    storage.setItem(DOCK_STORAGE_KEY, dock);
  }
}

/** The page's stored dock, in the page's local storage. */
export const dockStorage = createDockStorage();
