// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { pageLocalStorage, type SafeStorage } from '@dotli/shared';
import { createPersistentAtom } from '@dotli/stores-persistent';
import type { WritableAtom } from 'nanostores';
import { themeState, type ThemePreference } from './runtime/state/themeState.js';
import { THEME_KEY } from './themeKey.js';

/** The page parts the theme reads and writes. */
type Params = {
  /** The theme the user chose, kept for later sessions. */
  preference: WritableAtom<ThemePreference>;
  /** Whether the OS prefers a light scheme, and its changes. */
  colorScheme: () => Pick<MediaQueryList, 'matches' | 'addEventListener' | 'removeEventListener'>;
  /** Carries `data-theme` and `data-theme-pref`, the page state the functional tests read. */
  root: () => Pick<Element, 'setAttribute'>;
};

type CreateThemePreferenceParams = {
  /** Where the choice is kept. */
  storage: Pick<SafeStorage, 'getItem' | 'setItem' | 'removeItem'>;
};

export type ThemeController = ReturnType<typeof createThemeController>;

/** Builds the theme over `preference`, the OS colour scheme and `root`. Never throws. */
export function createThemeController({ preference, colorScheme, root }: Params) {
  function resolveTheme(chosen: ThemePreference): 'light' | 'dark' {
    if (chosen !== 'system') {
      return chosen;
    }
    return colorScheme().matches ? 'light' : 'dark';
  }

  function applyThemePref(chosen: ThemePreference): void {
    const resolved = resolveTheme(chosen);
    const element = root();
    element.setAttribute('data-theme-pref', chosen);
    element.setAttribute('data-theme', resolved);
    // The product follows the theme through this store.
    themeState.set({ preference: chosen, resolved });
  }

  function startTheme(): () => void {
    applyThemePref(preference.get());

    const systemScheme = colorScheme();
    // One listener per start, so each start's stop removes only its own.
    function followSystemTheme(): void {
      if (preference.get() === 'system') {
        applyThemePref('system');
      }
    }
    function unfollowSystemTheme(): void {
      systemScheme.removeEventListener('change', followSystemTheme);
    }
    systemScheme.addEventListener('change', followSystemTheme);
    return unfollowSystemTheme;
  }

  function selectThemePref(chosen: ThemePreference): void {
    preference.set(chosen);
    applyThemePref(chosen);
  }

  return {
    /**
     * Applies the stored choice and follows the OS while it is System, until the returned stop. Throws only as
     * `colorScheme` or `root` does.
     */
    startTheme,
    /** Stores and applies `chosen`. Throws only as `root` does. */
    selectThemePref,
  };
}

/**
 * Builds the theme choice kept in `storage`, System when nothing there parses. Choosing System removes the key. Never
 * throws.
 */
export function createThemePreference({ storage }: CreateThemePreferenceParams): WritableAtom<ThemePreference> {
  return createPersistentAtom<ThemePreference>({
    key: THEME_KEY,
    storage,
    initial: 'system',
    decode: decodeThemePreference,
    // The key holds the bare name, not JSON, so a choice stored by an earlier build still reads.
    encode: value => value,
  });
}

// Built on first use, since the stored choice is read when its atom is built and a prerender loads this module too.
let page: ThemeController | undefined;

/** The page's theme, over its localStorage, the OS colour scheme and the document's root element. */
export const pageTheme: ThemeController = {
  startTheme: startPageTheme,
  selectThemePref: selectPageThemePref,
};

function startPageTheme(): () => void {
  return getPageTheme().startTheme();
}

function selectPageThemePref(preference: ThemePreference): void {
  getPageTheme().selectThemePref(preference);
}

function getPageTheme(): ThemeController {
  page ??= createThemeController({
    preference: createThemePreference({ storage: pageLocalStorage }),
    colorScheme: () => window.matchMedia('(prefers-color-scheme: light)'),
    root: () => document.documentElement,
  });
  return page;
}

function decodeThemePreference(raw: string): ThemePreference | undefined {
  return raw === 'light' || raw === 'dark' || raw === 'system' ? raw : undefined;
}
