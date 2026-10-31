// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Imports no Solid, so the spec runs under Node.

import { pageLocalStorage } from '@dotli/shared';
import type { PanelStorage } from './panelStorage.js';

/** The panel's top-level tabs. Only `truapi` shows the captured events. */
export type PanelSection = 'truapi' | 'resolution' | 'archive' | 'diagnostics' | 'wallet';

type Params = {
  /** Where the tab is kept. */
  storage?: PanelStorage;
};

const SECTION_STORAGE_KEY = 'truapi-debug:section';

/** Every panel section, in display order. */
export const PANEL_SECTIONS: readonly PanelSection[] = ['truapi', 'resolution', 'archive', 'diagnostics', 'wallet'];

/** The panel's open tab, kept in `storage` from one mount to the next. */
export function createSectionStorage({ storage = pageLocalStorage }: Params = {}) {
  return {
    /** The stored tab, or TrUAPI when none or an unknown one is stored. Throws only what `storage` throws. */
    read,
    /** Stores `section` for the next mount. Throws only what `storage` throws. */
    write,
  };

  function read(): PanelSection {
    const stored = storage.getItem(SECTION_STORAGE_KEY);
    return isPanelSection(stored) ? stored : 'truapi';
  }

  function write(section: PanelSection): void {
    storage.setItem(SECTION_STORAGE_KEY, section);
  }
}

/** The page's stored tab, in the page's local storage. */
export const sectionStorage = createSectionStorage();

function isPanelSection(value: string | null): value is PanelSection {
  return PANEL_SECTIONS.some(section => section === value);
}
