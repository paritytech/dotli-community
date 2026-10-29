// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { pageLocalStorage, type SafeStorage } from '@dotli/shared';
import { themeState, type ThemePreference } from './runtime/state/themeState.js';
import { THEME_KEY } from './themeKey.js';

/** The page parts the theme reads and writes. */
type Params = {
  /** This origin's localStorage, which never throws. */
  storage: Pick<SafeStorage, 'getItem' | 'setItem'>;
  /** Whether the OS prefers a light scheme, and its changes. */
  colorScheme: () => Pick<MediaQueryList, 'matches' | 'addEventListener' | 'removeEventListener'>;
  /** Carries `data-theme` and `data-theme-pref`, the page state the functional tests read. */
  root: () => Pick<Element, 'setAttribute'>;
};

export type ThemeController = ReturnType<typeof createThemeController>;

/** Builds the theme over `storage`, the OS colour scheme and `root`. Never throws. */
export function createThemeController({ storage, colorScheme, root }: Params) {
  function getStoredThemePref(): ThemePreference {
    const stored = storage.getItem(THEME_KEY);
    return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system';
  }

  function resolveTheme(preference: ThemePreference): 'light' | 'dark' {
    if (preference !== 'system') {
      return preference;
    }
    return colorScheme().matches ? 'light' : 'dark';
  }

  function applyThemePref(preference: ThemePreference): void {
    const resolved = resolveTheme(preference);
    const element = root();
    element.setAttribute('data-theme-pref', preference);
    element.setAttribute('data-theme', resolved);
    // The product follows the theme through this store.
    themeState.set({ preference, resolved });
  }

  function startTheme(): () => void {
    applyThemePref(getStoredThemePref());

    const systemScheme = colorScheme();
    // One listener per start, so each start's stop removes only its own.
    function followSystemTheme(): void {
      if (getStoredThemePref() === 'system') {
        applyThemePref('system');
      }
    }
    function unfollowSystemTheme(): void {
      systemScheme.removeEventListener('change', followSystemTheme);
    }
    systemScheme.addEventListener('change', followSystemTheme);
    return unfollowSystemTheme;
  }

  function selectThemePref(preference: ThemePreference): void {
    storage.setItem(THEME_KEY, preference);
    applyThemePref(preference);
  }

  return {
    /**
     * Applies the stored choice and follows the OS while it is System, until the returned stop. Throws only as
     * `colorScheme` or `root` does.
     */
    startTheme,
    /** Stores and applies `preference`. Throws only as `root` does. */
    selectThemePref,
  };
}

/** The page's theme, over its localStorage, the OS colour scheme and the document's root element. */
export const pageTheme = createThemeController({
  storage: pageLocalStorage,
  colorScheme: () => window.matchMedia('(prefers-color-scheme: light)'),
  root: () => document.documentElement,
});
