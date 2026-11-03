// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { themeState, type ThemePreference, type ThemeStore } from './runtime/state/themeState.js';

/** The page parts the theme reads and writes. */
type Params = {
  /** The theme the user chose and the OS scheme it resolves System against. */
  theme: Pick<ThemeStore, 'store' | 'selectPreference' | 'showSystemScheme'>;
  /** Whether the OS prefers a light scheme, and its changes. */
  colorScheme: () => Pick<MediaQueryList, 'matches' | 'addEventListener' | 'removeEventListener'>;
  /** Carries `data-theme` and `data-theme-pref`, the page state the functional tests read. */
  root: () => Pick<Element, 'setAttribute'>;
};

export type ThemeController = ReturnType<typeof createThemeController>;

/** Builds the theme controller, which shows the OS colour scheme to `theme` and writes the theme on `root`. */
export function createThemeController({ theme, colorScheme, root }: Params) {
  // The OS is asked on every apply, so a choice made before any start still resolves System against it.
  function askSystemScheme(): void {
    theme.showSystemScheme(colorScheme().matches ? 'light' : 'dark');
  }

  function writeRoot(): void {
    const { preference, resolved } = theme.store.get();
    const element = root();
    element.setAttribute('data-theme-pref', preference);
    element.setAttribute('data-theme', resolved);
  }

  function applyTheme(): void {
    askSystemScheme();
    writeRoot();
  }

  function startTheme(): () => void {
    applyTheme();

    const systemScheme = colorScheme();
    // One listener per start, so each start's stop removes only its own.
    function followSystemTheme(): void {
      applyTheme();
    }
    function unfollowSystemTheme(): void {
      systemScheme.removeEventListener('change', followSystemTheme);
    }
    systemScheme.addEventListener('change', followSystemTheme);
    return unfollowSystemTheme;
  }

  function selectThemePref(chosen: ThemePreference): void {
    // The scheme goes first, so a listener of the theme never hears System resolved against a stale one.
    askSystemScheme();
    theme.selectPreference(chosen);
    writeRoot();
  }

  return {
    /**
     * Applies the stored choice and follows the OS while it is System, until the returned stop. Throws only as
     * `colorScheme` or `root` does.
     */
    startTheme,
    /** Stores and applies `chosen`. Throws only as `colorScheme` or `root` does. */
    selectThemePref,
  };
}

/** The page's theme, over its theme state, the OS colour scheme and the document's root element. */
export const pageTheme: ThemeController = createThemeController({
  theme: themeState,
  colorScheme: () => window.matchMedia('(prefers-color-scheme: light)'),
  root: () => document.documentElement,
});
