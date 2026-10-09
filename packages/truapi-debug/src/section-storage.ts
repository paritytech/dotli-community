// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Must not import `@dotli/ui` or `solid-js`, whose truapi-debug components consume it.

/** The panel's top-level tabs. Only `truapi` shows the captured events. */
export type PanelSection = 'truapi' | 'resolution' | 'archive' | 'diagnostics' | 'wallet';

export const SECTION_STORAGE_KEY = 'truapi-debug:section';

const SECTIONS: readonly PanelSection[] = ['truapi', 'resolution', 'archive', 'diagnostics', 'wallet'];

function isPanelSection(value: string | null): value is PanelSection {
  return SECTIONS.some(section => section === value);
}

export function readStoredSection(): PanelSection {
  try {
    const raw = localStorage.getItem(SECTION_STORAGE_KEY);
    if (isPanelSection(raw)) {
      return raw;
    }
    // eslint-disable-next-line no-restricted-syntax -- localStorage may throw in Safari private mode; default to the TrUAPI tab.
  } catch {
    /* swallow */
  }
  return 'truapi';
}

export function writeStoredSection(section: PanelSection): void {
  try {
    localStorage.setItem(SECTION_STORAGE_KEY, section);
    // eslint-disable-next-line no-restricted-syntax -- localStorage may throw on quota/private mode; persistence is best-effort.
  } catch {
    /* swallow */
  }
}
