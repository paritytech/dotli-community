// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Imports no Solid, so the spec runs under Node.

import { pageLocalStorage } from '@dotli/shared';
import { createPersistentAtom } from '@dotli/stores-persistent';
import type { PanelStorage } from './panelStorage.js';

/** The panel's top-level tabs. Only `truapi` shows the captured events. */
export type PanelSection = 'truapi' | 'resolution' | 'archive' | 'diagnostics' | 'wallet';

type SectionStorage = ReturnType<typeof createSectionStorage>;

type Params = {
  /** Where the tab is kept. */
  storage?: PanelStorage;
};

const SECTION_STORAGE_KEY = 'truapi-debug:section';

/** Every panel section, in display order. */
export const PANEL_SECTIONS: readonly PanelSection[] = ['truapi', 'resolution', 'archive', 'diagnostics', 'wallet'];

/**
 * The panel's open tab, kept in `storage` from one mount to the next. TrUAPI when nothing there parses, and going back
 * to TrUAPI removes the key. Never throws.
 */
export function createSectionStorage({ storage = pageLocalStorage }: Params = {}) {
  return createPersistentAtom<PanelSection>({
    key: SECTION_STORAGE_KEY,
    storage,
    initial: 'truapi',
    decode: decodeSection,
    // The key holds the bare name, not JSON, so a tab stored by an earlier build still reads.
    encode: value => value,
  });
}

// Built on first use, so importing the module reads no storage.
let page: SectionStorage | undefined;

/** The page's open tab, in the page's local storage, the same atom on every call. Never throws. */
export function getSectionStorage(): SectionStorage {
  page ??= createSectionStorage();
  return page;
}

function decodeSection(raw: string): PanelSection | undefined {
  return PANEL_SECTIONS.find(section => section === raw);
}
