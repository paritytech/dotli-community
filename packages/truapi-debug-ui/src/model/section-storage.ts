// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Must not import `@dotli/truapi-debug-ui` or `solid-js`, whose components consume it.

/** The panel's top-level tabs. Only `truapi` shows the captured events. */
export type PanelSection = 'truapi' | 'resolution' | 'archive' | 'diagnostics' | 'wallet';

/** Where the panel keeps its choices. `localStorage` is one. */
export type PanelStorage = Pick<Storage, 'getItem' | 'setItem'>;

const SECTION_STORAGE_KEY = 'truapi-debug:section';

const SECTIONS: readonly PanelSection[] = ['truapi', 'resolution', 'archive', 'diagnostics', 'wallet'];

function isPanelSection(value: string | null): value is PanelSection {
  return SECTIONS.some(section => section === value);
}

/** The stored tab, or TrUAPI. `storage` is a thunk because reading `localStorage` itself may throw. */
export function readStoredSection(storage: () => PanelStorage = () => localStorage): PanelSection {
  try {
    const raw = storage().getItem(SECTION_STORAGE_KEY);
    if (isPanelSection(raw)) {
      return raw;
    }
    // eslint-disable-next-line no-restricted-syntax -- localStorage may throw in Safari private mode; default to the TrUAPI tab.
  } catch {
    /* swallow */
  }
  return 'truapi';
}

export function writeStoredSection(section: PanelSection, storage: () => PanelStorage = () => localStorage): void {
  try {
    storage().setItem(SECTION_STORAGE_KEY, section);
    // eslint-disable-next-line no-restricted-syntax -- localStorage may throw on quota/private mode; persistence is best-effort.
  } catch {
    /* swallow */
  }
}
