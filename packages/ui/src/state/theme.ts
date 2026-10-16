// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSyncStore, shallowEqual, type ReadableStore } from './create-store.js';

export type ThemePref = 'light' | 'dark' | 'system';

export interface ThemeState {
  pref: ThemePref;
  resolved: 'light' | 'dark';
}

// Dark matches the stylesheet default until initTheme writes the stored or system preference at boot.
const theme = createSyncStore<ThemeState>('theme', { pref: 'system', resolved: 'dark' }, { equals: shallowEqual });

export const themeStore: ReadableStore<ThemeState> = theme;
export const getThemeState = theme.get;

/** The TrUAPI theme bridge forwards `dotli:theme-changed` to products. */
export function setTheme(next: ThemeState): void {
  theme.set(next);
  window.dispatchEvent(new Event('dotli:theme-changed'));
}
