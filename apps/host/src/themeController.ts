// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { pageLocalStorage, type SafeStorage } from '@dotli/shared';
import { themeState, type ThemePreference } from './runtime/state/themeState.js';

/** The stored choice's key, also cleared by a settings reset. */
export const THEME_KEY = 'dotli-theme';

/** The page parts the theme reads and writes. */
export type ThemeControllerDeps = {
  /** This origin's localStorage, which never throws. */
  storage: Pick<SafeStorage, 'getItem' | 'setItem'>;
  /** Whether the OS prefers a light scheme, and its changes. */
  colorScheme: () => Pick<MediaQueryList, 'matches' | 'addEventListener' | 'removeEventListener'>;
  /** Carries `data-theme` and `data-theme-pref`, the page state the functional tests read. */
  root: () => Pick<Element, 'setAttribute'>;
};

export type ThemeController = {
  /** Applies the stored choice and follows the OS while it is System, until the returned stop. */
  startTheme: () => () => void;
  selectThemePref: (preference: ThemePreference) => void;
};

export function createThemeController({ storage, colorScheme, root }: ThemeControllerDeps): ThemeController {
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
    // The TrUAPI bridge follows this store to forward the theme to the product.
    themeState.set({ preference, resolved });
  }

  return {
    startTheme: () => {
      applyThemePref(getStoredThemePref());

      const os = colorScheme();
      const follow = (): void => {
        if (getStoredThemePref() === 'system') {
          applyThemePref('system');
        }
      };
      os.addEventListener('change', follow);
      return () => {
        os.removeEventListener('change', follow);
      };
    },
    selectThemePref: preference => {
      storage.setItem(THEME_KEY, preference);
      applyThemePref(preference);
    },
  };
}

const pageTheme = createThemeController({
  storage: pageLocalStorage,
  colorScheme: () => window.matchMedia('(prefers-color-scheme: light)'),
  root: () => document.documentElement,
});

export const startTheme = pageTheme.startTheme;

export const selectThemePref = pageTheme.selectThemePref;
