// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSyncStore, shallowEqual, type ReadableStore } from '@dotli/shared';

export type ThemePref = 'light' | 'dark' | 'system';

export interface ThemeState {
  pref: ThemePref;
  resolved: 'light' | 'dark';
}

// Dark matches the stylesheet default until startTheme writes the stored or system preference at boot.
const theme = createSyncStore<ThemeState>('theme', { pref: 'system', resolved: 'dark' }, { equals: shallowEqual });

export const themeStore: ReadableStore<ThemeState> = theme;
export const getThemeState = theme.get;

export function setTheme(next: ThemeState): void {
  theme.set(next);
}
