// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { isShallowEqual, pageLocalStorage, registerAtomReset } from '@dotli/shared';
import { createPersistentAtom, type PersistentAtomParams } from '@dotli/stores-persistent';
import { atom, computed } from 'nanostores';
import { THEME_KEY } from '../../themeKey.js';

/** The theme the user chose, where System follows the OS. */
export type ThemePreference = 'light' | 'dark' | 'system';

/** The page's theme. */
export type ThemeState = {
  /** The theme the user chose. */
  preference: ThemePreference;
  /** The theme the page shows, the OS's own for System. */
  resolved: 'light' | 'dark';
};

type ColorScheme = ThemeState['resolved'];

type Params = {
  /** Keeps the theme the user chose for later sessions. */
  storage: PersistentAtomParams<ThemePreference>['storage'];
};

export type ThemeStore = ReturnType<typeof createThemeState>;

/**
 * Builds the theme over the choice kept in `storage` and the OS scheme last shown to it. The choice is System when
 * nothing stored parses, and choosing System removes it. The OS scheme is dark until shown, as the prerender is.
 */
export function createThemeState({ storage }: Params) {
  const preference = createPersistentAtom<ThemePreference>({
    key: THEME_KEY,
    storage,
    initial: 'system',
    decode: decodeThemePreference,
    encode: String,
  });
  registerAtomReset(preference);
  const systemScheme = atom<ColorScheme>('dark');
  registerAtomReset(systemScheme);

  const theme = computed([preference, systemScheme], resolveTheme);
  theme.eq = isShallowEqual;

  function selectPreference(chosen: ThemePreference): void {
    preference.set(chosen);
  }

  function showSystemScheme(scheme: ColorScheme): void {
    systemScheme.set(scheme);
  }

  return {
    /** The current theme. A change of the OS scheme under a chosen theme notifies nobody. */
    store: theme,
    /** Keeps and shows `chosen`. Never throws. */
    selectPreference,
    /** Shows the OS scheme that System resolves to. Never throws. */
    showSystemScheme,
  };
}

/** The page's theme, over its localStorage. */
export const themeState: ThemeStore = createThemeState({ storage: pageLocalStorage });

function resolveTheme(preference: ThemePreference, scheme: ColorScheme): ThemeState {
  return { preference, resolved: preference === 'system' ? scheme : preference };
}

function decodeThemePreference(raw: string): ThemePreference | undefined {
  return raw === 'light' || raw === 'dark' || raw === 'system' ? raw : undefined;
}
