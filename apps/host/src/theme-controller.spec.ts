// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getThemeState, themeStore } from './runtime/state/theme.js';
import { createThemeController, type ThemeController } from './theme-controller.js';
import { memoryStorage, resetAllStoresForTests } from '@dotli/shared/testing';
import { FakeColorScheme } from './testing/color-scheme.js';

let local: Pick<Storage, 'getItem' | 'setItem'>;
let os: FakeColorScheme;
/** The attributes the controller set on the root element. */
let root: Map<string, string>;

beforeEach(() => {
  resetAllStoresForTests();
  local = memoryStorage();
  os = new FakeColorScheme('dark');
  root = new Map();
});

/** The OS colour scheme the controller starts from. */
function stubColorScheme(initial: 'light' | 'dark'): FakeColorScheme {
  os = new FakeColorScheme(initial);
  return os;
}

/** A controller over this test's storage, OS scheme and root, with the theme store it publishes to. */
function loadController(): ThemeController & { getThemeState: typeof getThemeState; themeStore: typeof themeStore } {
  const controller = createThemeController({
    storage: () => local,
    colorScheme: () => os,
    root: () => ({
      setAttribute: (name: string, value: string) => {
        root.set(name, value);
      },
    }),
  });
  return { ...controller, getThemeState, themeStore };
}

/** A localStorage whose every access throws, as when the browser blocks it. */
function blockedStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  const blocked = (): never => {
    throw new DOMException('The operation is insecure.', 'SecurityError');
  };
  return { getItem: blocked, setItem: blocked };
}

describe('theme controller', () => {
  it('As a dotli user, a fresh profile defaults to the System option', () => {
    // Given
    stubColorScheme('light');
    const { initTheme, getThemeState: state } = loadController();

    // When
    initTheme();

    // Then
    expect(local.getItem('dotli-theme')).toBeNull();
    expect(root.get('data-theme-pref')).toBe('system');
    expect(root.get('data-theme')).toBe('light');
    expect(state()).toEqual({ pref: 'system', resolved: 'light' });
  });

  it('As a returning dotli user, my stored theme is applied to the page and the store', () => {
    // Given
    stubColorScheme('dark');
    local.setItem('dotli-theme', 'light');
    const { initTheme, getThemeState: state } = loadController();

    // When
    initTheme();

    // Then
    expect(root.get('data-theme-pref')).toBe('light');
    expect(root.get('data-theme')).toBe('light');
    expect(state()).toEqual({ pref: 'light', resolved: 'light' });
  });

  it('As a dotli user, an unreadable stored value falls back to the System option, as the head script does', () => {
    // Given
    stubColorScheme('dark');
    local.setItem('dotli-theme', 'sepia');
    const { initTheme } = loadController();

    // When
    initTheme();

    // Then
    expect(root.get('data-theme-pref')).toBe('system');
    expect(root.get('data-theme')).toBe('dark');
  });

  it('As a dotli user whose browser blocks storage, the theme falls back to System and follows the OS', () => {
    // Given
    const os = stubColorScheme('light');
    local = blockedStorage();
    const { initTheme, getThemeState: state } = loadController();

    // When
    initTheme();

    // Then
    expect(root.get('data-theme-pref')).toBe('system');
    expect(state()).toEqual({ pref: 'system', resolved: 'light' });

    // When
    os.set('dark');

    // Then
    expect(root.get('data-theme')).toBe('dark');
    expect(state()).toEqual({ pref: 'system', resolved: 'dark' });
  });

  it('As a dotli user whose browser blocks storage, the theme I select still applies', () => {
    // Given
    stubColorScheme('light');
    local = blockedStorage();
    const { initTheme, selectThemePref, getThemeState: state } = loadController();
    initTheme();

    // When
    selectThemePref('dark');

    // Then
    expect(root.get('data-theme-pref')).toBe('dark');
    expect(root.get('data-theme')).toBe('dark');
    expect(state()).toEqual({ pref: 'dark', resolved: 'dark' });
  });

  it('As the TrUAPI theme bridge, I hear initTheme publish the OS theme through the store', () => {
    // Given: a light OS, as the store starts dark.
    stubColorScheme('light');
    const { initTheme, themeStore } = loadController();
    const onThemeChanged = vi.fn();
    const stop = themeStore.subscribe(onThemeChanged);

    // When
    initTheme();
    stop();

    // Then
    expect(onThemeChanged).toHaveBeenCalledTimes(1);
  });

  it('As a dotli user, I select Dark and it applies and persists', () => {
    // Given
    stubColorScheme('light');
    local.setItem('dotli-theme', 'light');
    const { initTheme, selectThemePref, getThemeState: state, themeStore } = loadController();
    initTheme();
    const onThemeChanged = vi.fn();
    const stop = themeStore.subscribe(onThemeChanged);

    // When
    selectThemePref('dark');
    stop();

    // Then
    expect(local.getItem('dotli-theme')).toBe('dark');
    expect(root.get('data-theme-pref')).toBe('dark');
    expect(root.get('data-theme')).toBe('dark');
    expect(state()).toEqual({ pref: 'dark', resolved: 'dark' });
    expect(onThemeChanged).toHaveBeenCalledTimes(1);
  });

  it('As a dotli user, I select System and the theme resolves from the OS', () => {
    // Given
    stubColorScheme('light');
    local.setItem('dotli-theme', 'dark');
    const { initTheme, selectThemePref } = loadController();
    initTheme();

    // When
    selectThemePref('system');

    // Then
    expect(local.getItem('dotli-theme')).toBe('system');
    expect(root.get('data-theme-pref')).toBe('system');
    expect(root.get('data-theme')).toBe('light');
  });

  it('As a dotli user, the System option follows OS theme changes', () => {
    // Given
    const os = stubColorScheme('dark');
    local.setItem('dotli-theme', 'system');
    const { initTheme, themeStore } = loadController();
    let changes = 0;
    const stop = themeStore.subscribe(() => {
      changes += 1;
    });
    initTheme();
    const changesAfterInit = changes;

    // When
    os.set('light');
    stop();

    // Then
    expect(root.get('data-theme')).toBe('light');
    expect(changes).toBe(changesAfterInit + 1);
  });

  it('As a dotli user, an explicit theme ignores OS theme changes', () => {
    // Given
    const os = stubColorScheme('light');
    local.setItem('dotli-theme', 'dark');
    const { initTheme } = loadController();
    initTheme();

    // When
    os.set('dark');
    os.set('light');

    // Then
    expect(root.get('data-theme')).toBe('dark');
    expect(root.get('data-theme-pref')).toBe('dark');
  });

  it('As a dotli user who picked System after an explicit theme, OS changes are followed again', () => {
    // Given
    const os = stubColorScheme('dark');
    local.setItem('dotli-theme', 'light');
    const { initTheme, selectThemePref } = loadController();
    initTheme();
    selectThemePref('system');

    // When
    os.set('light');

    // Then
    expect(root.get('data-theme')).toBe('light');
  });

  it('As the prerendered shell, the store keeps its default until initTheme runs', () => {
    // Given
    stubColorScheme('light');
    local.setItem('dotli-theme', 'light');

    // When
    const { getThemeState } = loadController();

    // Then
    expect(getThemeState()).toEqual({ pref: 'system', resolved: 'dark' });
    expect(root.has('data-theme')).toBe(false);
  });

  it('As a dotli page whose shell state stopped, my theme no longer follows the OS', () => {
    // Given a System theme that followed the OS, then stopped
    const os = stubColorScheme('dark');
    local.setItem('dotli-theme', 'system');
    const { initTheme, getThemeState: state } = loadController();
    const stop = initTheme();
    stop();

    // When
    os.set('light');

    // Then
    expect(root.get('data-theme')).toBe('dark');
    expect(state()).toEqual({ pref: 'system', resolved: 'dark' });
  });
});
