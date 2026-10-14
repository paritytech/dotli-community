// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Must not import `@dotli/ui` or `solid-js`, whose truapi-debug components consume it.

/** The panel's top-level tabs. Only `truapi` shows the captured events. */
export type PanelSection = 'truapi' | 'resolution' | 'archive' | 'runtime' | 'diagnostics' | 'wallet';

export const SECTION_STORAGE_KEY = 'truapi-debug:section';

/** `runtime` is absent: it exists only while a PolkaVM product reports diagnostics, so it is never restored. */
type StoredSection = Exclude<PanelSection, 'runtime'>;

const SECTIONS: readonly StoredSection[] = ['truapi', 'resolution', 'archive', 'diagnostics', 'wallet'];

function isStoredSection(value: string | null): value is StoredSection {
  return SECTIONS.some(section => section === value);
}

export function readStoredSection(): StoredSection {
  try {
    const raw = localStorage.getItem(SECTION_STORAGE_KEY);
    if (isStoredSection(raw)) {
      return raw;
    }
    // eslint-disable-next-line no-restricted-syntax -- localStorage may throw in Safari private mode; default to the TrUAPI tab.
  } catch {
    /* swallow */
  }
  return 'truapi';
}

export function writeStoredSection(section: PanelSection): void {
  if (!isStoredSection(section)) {
    return;
  }
  try {
    localStorage.setItem(SECTION_STORAGE_KEY, section);
    // eslint-disable-next-line no-restricted-syntax -- localStorage may throw on quota/private mode; persistence is best-effort.
  } catch {
    /* swallow */
  }
}
