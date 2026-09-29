// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The host's theme preference: the stored choice (localStorage), following
// the OS while it is "system", the `<html>` attributes the stylesheet reads,
// and the theme store (state/theme.ts) that the toggle
// (components/shell/ThemeToggle.tsx) and the TrUAPI theme bridge follow.
//
// Before paint, the inline bootstrap script in apps/host/index.html sets the
// same `<html>` attributes from the same key and resolves them the same way,
// so initTheme() re-applies what is already on the page, never a different
// theme. Free of Solid: topbar.ts calls initTheme() on the boot path.

import { setTheme, type ThemePref } from './state/theme.js';

/** localStorage key of the theme preference; apps/host/index.html reads it too. */
export const THEME_KEY = 'dotli-theme';

/**
 * Read the persisted theme preference.
 *
 * An absent key means "system" so pre-existing users keep following the OS;
 * so does storage the browser blocks.
 */
function getStoredThemePref(): ThemePref {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') {
      return stored;
    }
    // eslint-disable-next-line no-restricted-syntax -- storage the browser blocks (SecurityError) means no stored choice: follow the OS, as the inline bootstrap script does.
  } catch {
    /* storage blocked: fall back to "system" */
  }
  return 'system';
}

function resolveTheme(pref: ThemePref): 'light' | 'dark' {
  if (pref !== 'system') {
    return pref;
  }
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function applyThemePref(pref: ThemePref): void {
  const resolved = resolveTheme(pref);
  // data-theme-pref drives the toggle icon, data-theme the actual colours.
  document.documentElement.setAttribute('data-theme-pref', pref);
  document.documentElement.setAttribute('data-theme', resolved);
  // The store notifies the Rust bridge to forward the new theme to the
  // embedded dApp.
  setTheme({ pref, resolved });
}

/** Apply the stored preference and follow OS changes while it is "system". */
export function initTheme(): void {
  applyThemePref(getStoredThemePref());

  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    if (getStoredThemePref() === 'system') {
      applyThemePref('system');
    }
  });
}

/** Persist and apply the preference the user picked. */
export function selectThemePref(pref: ThemePref): void {
  try {
    localStorage.setItem(THEME_KEY, pref);
    // eslint-disable-next-line no-restricted-syntax -- storage the browser blocks (SecurityError) must not stop the pick: it applies to this page only.
  } catch {
    /* storage blocked: the choice is not persisted */
  }
  applyThemePref(pref);
}
