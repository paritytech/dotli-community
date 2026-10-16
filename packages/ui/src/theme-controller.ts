// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Solid-free because it runs on the boot path. The host page's inline bootstrap script resolves the same
// key the same way before paint, so initTheme() must never apply a different theme.

import { setTheme, type ThemePref } from './state/theme.js';

/** Also read by the inline bootstrap script in apps/host/src/pages/index.astro. */
export const THEME_KEY = 'dotli-theme';

function getStoredThemePref(): ThemePref {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') {
      return stored;
    }
    // eslint-disable-next-line no-restricted-syntax -- storage the browser blocks (SecurityError) means no stored choice: follow the OS, as the inline bootstrap script does.
  } catch {
    // Falls back to "system".
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
  document.documentElement.setAttribute('data-theme-pref', pref);
  document.documentElement.setAttribute('data-theme', resolved);
  // The TrUAPI bridge follows this store to forward the theme to the product.
  setTheme({ pref, resolved });
}

export function initTheme(): void {
  applyThemePref(getStoredThemePref());

  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    if (getStoredThemePref() === 'system') {
      applyThemePref('system');
    }
  });
}

export function selectThemePref(pref: ThemePref): void {
  try {
    localStorage.setItem(THEME_KEY, pref);
    // eslint-disable-next-line no-restricted-syntax -- storage the browser blocks (SecurityError) must not stop the pick: it applies to this page only.
  } catch {
    // Not persisted.
  }
  applyThemePref(pref);
}
