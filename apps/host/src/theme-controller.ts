// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { setTheme, type ThemePref } from '@dotli/host-runtime';

/** The stored choice's key, also cleared by a settings reset. */
export const THEME_KEY = 'dotli-theme';

/** The page parts the theme reads and writes. */
export interface ThemeControllerDeps {
  /** Reached on every call, as the page's localStorage throws where the browser blocks it. */
  storage: () => Pick<Storage, 'getItem' | 'setItem'>;
  /** Whether the OS prefers a light scheme, and its changes. */
  colorScheme: () => Pick<MediaQueryList, 'matches' | 'addEventListener' | 'removeEventListener'>;
  /** Carries `data-theme` and `data-theme-pref`, the page state the functional tests read. */
  root: () => Pick<Element, 'setAttribute'>;
}

export interface ThemeController {
  /** Applies the stored choice and follows the OS while it is System, until the returned stop. */
  initTheme: () => () => void;
  selectThemePref: (pref: ThemePref) => void;
}

export function createThemeController({ storage, colorScheme, root }: ThemeControllerDeps): ThemeController {
  function getStoredThemePref(): ThemePref {
    try {
      const stored = storage().getItem(THEME_KEY);
      if (stored === 'light' || stored === 'dark' || stored === 'system') {
        return stored;
      }
      // eslint-disable-next-line no-restricted-syntax -- storage the browser blocks (SecurityError) means no stored choice: follow the OS.
    } catch {
      // Falls back to "system".
    }
    return 'system';
  }

  function resolveTheme(pref: ThemePref): 'light' | 'dark' {
    if (pref !== 'system') {
      return pref;
    }
    return colorScheme().matches ? 'light' : 'dark';
  }

  function applyThemePref(pref: ThemePref): void {
    const resolved = resolveTheme(pref);
    const element = root();
    element.setAttribute('data-theme-pref', pref);
    element.setAttribute('data-theme', resolved);
    // The TrUAPI bridge follows this store to forward the theme to the product.
    setTheme({ pref, resolved });
  }

  return {
    initTheme: () => {
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
    selectThemePref: pref => {
      try {
        storage().setItem(THEME_KEY, pref);
        // eslint-disable-next-line no-restricted-syntax -- storage the browser blocks (SecurityError) must not stop the pick: it applies to this page only.
      } catch {
        // Not persisted.
      }
      applyThemePref(pref);
    },
  };
}

const pageTheme = createThemeController({
  storage: () => localStorage,
  colorScheme: () => window.matchMedia('(prefers-color-scheme: light)'),
  root: () => document.documentElement,
});

export const initTheme = pageTheme.initTheme;

export const selectThemePref = pageTheme.selectThemePref;
