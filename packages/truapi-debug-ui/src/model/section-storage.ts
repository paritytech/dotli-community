// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Imports no Solid, so the spec runs under Node.

import { pageLocalStorage, type SafeStorage } from '@dotli/shared';

/** The panel's top-level tabs. Only `truapi` shows the captured events. */
export type PanelSection = 'truapi' | 'resolution' | 'archive' | 'diagnostics' | 'wallet';

/** Where the panel keeps its choices. `localStorage` is one. */
export type PanelStorage = Pick<SafeStorage, 'getItem' | 'setItem'>;

const SECTION_STORAGE_KEY = 'truapi-debug:section';

const SECTIONS: readonly PanelSection[] = ['truapi', 'resolution', 'archive', 'diagnostics', 'wallet'];

function isPanelSection(value: string | null): value is PanelSection {
  return SECTIONS.some(section => section === value);
}

/** The stored tab, or TrUAPI. */
export function readStoredSection(storage: PanelStorage = pageLocalStorage): PanelSection {
  const raw = storage.getItem(SECTION_STORAGE_KEY);
  return isPanelSection(raw) ? raw : 'truapi';
}

export function writeStoredSection(section: PanelSection, storage: PanelStorage = pageLocalStorage): void {
  storage.setItem(SECTION_STORAGE_KEY, section);
}
