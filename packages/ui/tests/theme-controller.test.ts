// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stubColorScheme } from './helpers/color-scheme.js';
import type * as ThemeControllerModule from '../src/theme-controller.js';
import type * as ThemeModule from '../src/state/theme.js';

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-theme-pref');
});

// A fresh module per test: initTheme() adds a matchMedia listener that lives
// as long as the module, and the store starts from its default.
async function loadController(): Promise<typeof ThemeControllerModule & typeof ThemeModule> {
  const controller = await import('../src/theme-controller.js');
  const store = await import('../src/state/theme.js');
  return { ...controller, ...store };
}

/** A localStorage whose every access throws, as when the browser blocks it. */
function blockedStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  const blocked = (): never => {
    throw new DOMException('The operation is insecure.', 'SecurityError');
  };
  return { getItem: blocked, setItem: blocked };
}

describe('theme controller', () => {
  it('As a dotli user, a fresh profile defaults to the System option', async () => {
    // Given
    stubColorScheme('light');
    const { initTheme, getThemeState: state } = await loadController();

    // When
    initTheme();

    // Then
    expect(localStorage.getItem('dotli-theme')).toBeNull();
    expect(document.documentElement.getAttribute('data-theme-pref')).toBe('system');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(state()).toEqual({ pref: 'system', resolved: 'light' });
  });

  it('As a returning dotli user, my stored theme is applied to the page and the store', async () => {
    // Given
    stubColorScheme('dark');
    localStorage.setItem('dotli-theme', 'light');
    const { initTheme, getThemeState: state } = await loadController();

    // When
    initTheme();

    // Then
    expect(document.documentElement.getAttribute('data-theme-pref')).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(state()).toEqual({ pref: 'light', resolved: 'light' });
  });

  it('As a dotli user, an unreadable stored value falls back to the System option, as the inline bootstrap script does', async () => {
    // Given
    stubColorScheme('dark');
    localStorage.setItem('dotli-theme', 'sepia');
    const { initTheme } = await loadController();

    // When
    initTheme();

    // Then
    expect(document.documentElement.getAttribute('data-theme-pref')).toBe('system');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('As a dotli user whose browser blocks storage, the theme falls back to System and follows the OS', async () => {
    // Given
    const os = stubColorScheme('light');
    vi.stubGlobal('localStorage', blockedStorage());
    const { initTheme, getThemeState: state } = await loadController();

    // When
    initTheme();

    // Then
    expect(document.documentElement.getAttribute('data-theme-pref')).toBe('system');
    expect(state()).toEqual({ pref: 'system', resolved: 'light' });

    // When
    os.set('dark');

    // Then
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(state()).toEqual({ pref: 'system', resolved: 'dark' });
  });

  it('As a dotli user whose browser blocks storage, the theme I select still applies', async () => {
    // Given
    stubColorScheme('light');
    vi.stubGlobal('localStorage', blockedStorage());
    const { initTheme, selectThemePref, getThemeState: state } = await loadController();
    initTheme();

    // When
    selectThemePref('dark');

    // Then
    expect(document.documentElement.getAttribute('data-theme-pref')).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(state()).toEqual({ pref: 'dark', resolved: 'dark' });
  });

  it('As the TrUAPI theme bridge, initTheme fires dotli:theme-changed', async () => {
    // Given
    stubColorScheme('dark');
    const { initTheme } = await loadController();
    const onThemeChanged = vi.fn();
    window.addEventListener('dotli:theme-changed', onThemeChanged);

    // When
    initTheme();
    window.removeEventListener('dotli:theme-changed', onThemeChanged);

    // Then
    expect(onThemeChanged).toHaveBeenCalledTimes(1);
  });

  it('As a dotli user, I select Dark and it applies and persists', async () => {
    // Given
    stubColorScheme('light');
    localStorage.setItem('dotli-theme', 'light');
    const { initTheme, selectThemePref, getThemeState: state } = await loadController();
    initTheme();
    const onThemeChanged = vi.fn();
    window.addEventListener('dotli:theme-changed', onThemeChanged);

    // When
    selectThemePref('dark');
    window.removeEventListener('dotli:theme-changed', onThemeChanged);

    // Then
    expect(localStorage.getItem('dotli-theme')).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme-pref')).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(state()).toEqual({ pref: 'dark', resolved: 'dark' });
    expect(onThemeChanged).toHaveBeenCalledTimes(1);
  });

  it('As a dotli user, I select System and the theme resolves from the OS', async () => {
    // Given
    stubColorScheme('light');
    localStorage.setItem('dotli-theme', 'dark');
    const { initTheme, selectThemePref } = await loadController();
    initTheme();

    // When
    selectThemePref('system');

    // Then
    expect(localStorage.getItem('dotli-theme')).toBe('system');
    expect(document.documentElement.getAttribute('data-theme-pref')).toBe('system');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('As a dotli user, the System option follows OS theme changes', async () => {
    // Given
    const os = stubColorScheme('dark');
    localStorage.setItem('dotli-theme', 'system');
    const { initTheme } = await loadController();
    let changes = 0;
    const onThemeChanged = (): void => {
      changes += 1;
    };
    window.addEventListener('dotli:theme-changed', onThemeChanged);
    initTheme();
    const changesAfterInit = changes;

    // When
    os.set('light');
    window.removeEventListener('dotli:theme-changed', onThemeChanged);

    // Then
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(changes).toBe(changesAfterInit + 1);
  });

  it('As a dotli user, an explicit theme ignores OS theme changes', async () => {
    // Given
    const os = stubColorScheme('light');
    localStorage.setItem('dotli-theme', 'dark');
    const { initTheme } = await loadController();
    initTheme();

    // When
    os.set('dark');
    os.set('light');

    // Then
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme-pref')).toBe('dark');
  });

  it('As a dotli user who picked System after an explicit theme, OS changes are followed again', async () => {
    // Given
    const os = stubColorScheme('dark');
    localStorage.setItem('dotli-theme', 'light');
    const { initTheme, selectThemePref } = await loadController();
    initTheme();
    selectThemePref('system');

    // When
    os.set('light');

    // Then
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('As the prerendered shell, the store keeps its default until initTheme runs', async () => {
    // Given
    stubColorScheme('light');
    localStorage.setItem('dotli-theme', 'light');

    // When
    const { getThemeState } = await loadController();

    // Then
    expect(getThemeState()).toEqual({ pref: 'system', resolved: 'dark' });
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });
});
