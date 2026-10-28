// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { themeState } from './runtime/state/themeState.js';
import { createThemeController, type ThemeController } from './themeController.js';
import { createSafeStorage, type SafeStorage } from '@dotli/shared';
import { createMemoryStorage, resetAllStoresForTests } from '@dotli/shared/testing';
import { FakeColorScheme } from './testing/colorScheme.js';

let local: Pick<SafeStorage, 'getItem' | 'setItem'>;
let os: FakeColorScheme;
/** The attributes the controller set on the root element. */
let root: Map<string, string>;

beforeEach(() => {
  resetAllStoresForTests();
  local = createMemoryStorage();
  os = new FakeColorScheme('dark');
  root = new Map();
});

/** The OS colour scheme the controller starts from. */
function stubColorScheme(initial: 'light' | 'dark'): FakeColorScheme {
  os = new FakeColorScheme(initial);
  return os;
}

/** A controller over this test's storage, OS scheme and root. */
function loadController(): ThemeController {
  return createThemeController({
    storage: local,
    colorScheme: () => os,
    root: () => ({
      setAttribute: (name: string, value: string) => {
        root.set(name, value);
      },
    }),
  });
}

/** A localStorage whose every access throws, as when the browser blocks it. */
function blockedStorage(): SafeStorage {
  return createSafeStorage(() => {
    throw new DOMException('The operation is insecure.', 'SecurityError');
  });
}

describe('theme controller', () => {
  it('As a dotli user, a fresh profile defaults to the System option', () => {
    // Given
    stubColorScheme('light');
    const { startTheme } = loadController();

    // When
    startTheme();

    // Then
    expect(local.getItem('dotli-theme')).toBeNull();
    expect(root.get('data-theme-pref')).toBe('system');
    expect(root.get('data-theme')).toBe('light');
    expect(themeState.get()).toEqual({ preference: 'system', resolved: 'light' });
  });

  it('As a returning dotli user, my stored theme is applied to the page and the store', () => {
    // Given
    stubColorScheme('dark');
    local.setItem('dotli-theme', 'light');
    const { startTheme } = loadController();

    // When
    startTheme();

    // Then
    expect(root.get('data-theme-pref')).toBe('light');
    expect(root.get('data-theme')).toBe('light');
    expect(themeState.get()).toEqual({ preference: 'light', resolved: 'light' });
  });

  it('As a dotli user, an unreadable stored value falls back to the System option, as the head script does', () => {
    // Given
    stubColorScheme('dark');
    local.setItem('dotli-theme', 'sepia');
    const { startTheme } = loadController();

    // When
    startTheme();

    // Then
    expect(root.get('data-theme-pref')).toBe('system');
    expect(root.get('data-theme')).toBe('dark');
  });

  it('As a dotli user whose browser blocks storage, the theme falls back to System and follows the OS', () => {
    // Given
    const os = stubColorScheme('light');
    local = blockedStorage();
    const { startTheme } = loadController();

    // When
    startTheme();

    // Then
    expect(root.get('data-theme-pref')).toBe('system');
    expect(themeState.get()).toEqual({ preference: 'system', resolved: 'light' });

    // When
    os.set('dark');

    // Then
    expect(root.get('data-theme')).toBe('dark');
    expect(themeState.get()).toEqual({ preference: 'system', resolved: 'dark' });
  });

  it('As a dotli user whose browser blocks storage, the theme I select still applies', () => {
    // Given
    stubColorScheme('light');
    local = blockedStorage();
    const { startTheme, selectThemePref } = loadController();
    startTheme();

    // When
    selectThemePref('dark');

    // Then
    expect(root.get('data-theme-pref')).toBe('dark');
    expect(root.get('data-theme')).toBe('dark');
    expect(themeState.get()).toEqual({ preference: 'dark', resolved: 'dark' });
  });

  it('As the TrUAPI theme bridge, I hear startTheme publish the OS theme through the store', () => {
    // Given: a light OS, as the store starts dark.
    stubColorScheme('light');
    const { startTheme } = loadController();
    const onThemeChanged = vi.fn();
    const stop = themeState.store.subscribe(onThemeChanged);

    // When
    startTheme();
    stop();

    // Then
    expect(onThemeChanged).toHaveBeenCalledTimes(1);
  });

  it('As a dotli user, I select Dark and it applies and persists', () => {
    // Given
    stubColorScheme('light');
    local.setItem('dotli-theme', 'light');
    const { startTheme, selectThemePref } = loadController();
    startTheme();
    const onThemeChanged = vi.fn();
    const stop = themeState.store.subscribe(onThemeChanged);

    // When
    selectThemePref('dark');
    stop();

    // Then
    expect(local.getItem('dotli-theme')).toBe('dark');
    expect(root.get('data-theme-pref')).toBe('dark');
    expect(root.get('data-theme')).toBe('dark');
    expect(themeState.get()).toEqual({ preference: 'dark', resolved: 'dark' });
    expect(onThemeChanged).toHaveBeenCalledTimes(1);
  });

  it('As a dotli user, I select System and the theme resolves from the OS', () => {
    // Given
    stubColorScheme('light');
    local.setItem('dotli-theme', 'dark');
    const { startTheme, selectThemePref } = loadController();
    startTheme();

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
    const { startTheme } = loadController();
    let changes = 0;
    const stop = themeState.store.subscribe(() => {
      changes += 1;
    });
    startTheme();
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
    const { startTheme } = loadController();
    startTheme();

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
    const { startTheme, selectThemePref } = loadController();
    startTheme();
    selectThemePref('system');

    // When
    os.set('light');

    // Then
    expect(root.get('data-theme')).toBe('light');
  });

  it('As the prerendered shell, the store keeps its default until startTheme runs', () => {
    // Given
    stubColorScheme('light');
    local.setItem('dotli-theme', 'light');

    // When
    loadController();

    // Then
    expect(themeState.get()).toEqual({ preference: 'system', resolved: 'dark' });
    expect(root.has('data-theme')).toBe(false);
  });

  it('As a dotli page whose shell state stopped, my theme no longer follows the OS', () => {
    // Given a System theme that followed the OS, then stopped
    const os = stubColorScheme('dark');
    local.setItem('dotli-theme', 'system');
    const { startTheme } = loadController();
    const stop = startTheme();
    stop();

    // When
    os.set('light');

    // Then
    expect(root.get('data-theme')).toBe('dark');
    expect(themeState.get()).toEqual({ preference: 'system', resolved: 'dark' });
  });
});
