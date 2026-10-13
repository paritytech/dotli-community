// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The page's head script paints the stored theme choice with this before first paint, and theme-controller.ts takes
// over after boot. The two must resolve the same key the same way, which theme-paint.spec.ts pins. The head script
// bundles this module, so it imports nothing.

/** The same key theme-controller.ts stores the choice under. */
const THEME_KEY = 'dotli-theme';

/** The page parts painting the theme reads and writes. */
export interface ThemePaintDeps {
  /** Reached on every call, as the page's localStorage throws where the browser blocks it. */
  storage: () => Pick<Storage, 'getItem'>;
  /** Whether the OS prefers a light scheme. */
  colorScheme: () => Pick<MediaQueryList, 'matches'>;
  /** Carries `data-theme` and `data-theme-pref` for the stylesheet. */
  root: () => Pick<Element, 'setAttribute'>;
}

/** Sets the stored choice, System when there is none, and the theme it resolves to on the root. */
export function paintStoredTheme({ storage, colorScheme, root }: ThemePaintDeps): void {
  let pref = 'system';
  try {
    const stored = storage().getItem(THEME_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') {
      pref = stored;
    }
    // eslint-disable-next-line no-restricted-syntax -- storage the browser blocks (SecurityError) means no stored choice: follow the OS.
  } catch {
    // Falls back to "system".
  }
  const theme = pref !== 'system' ? pref : colorScheme().matches ? 'light' : 'dark';
  const element = root();
  element.setAttribute('data-theme-pref', pref);
  element.setAttribute('data-theme', theme);
}
