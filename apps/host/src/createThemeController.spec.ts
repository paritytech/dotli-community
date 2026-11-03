// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { createThemeState, type ThemeState, type ThemeStore } from './runtime/state/themeState.js';
import { createThemeController, type ThemeController } from './createThemeController.js';
import type { SafeStorage } from '@dotli/shared';
import { createMemoryStorage } from '@dotli/shared/testing';
import { createBlockedStorage } from './testing/createBlockedStorage.js';
import { createFakeColorScheme, type FakeColorScheme } from './testing/createFakeColorScheme.js';

/** The page a theme controller runs on: its storage, the OS scheme and the root element's attributes. */
type ThemePage = {
  local: Pick<SafeStorage, 'getItem' | 'setItem' | 'removeItem'>;
  os: FakeColorScheme;
  /** The attributes the controller set on the root element. */
  root: Map<string, string>;
  /** Builds a theme state and a controller over this page, reading its stored theme as a page load does. */
  loadController: () => ThemeController & Pick<ThemeStore, 'store'>;
};

type Params = {
  /** The OS colour scheme the page starts from. */
  scheme: 'light' | 'dark';
  /** Whether the browser blocks storage. */
  blocked?: boolean;
};

describe('theme controller', () => {
  it('As a dotli user with a fresh profile, I open dotli and the theme is the System option', () => {
    // Given
    const { local, root, loadController } = setupThemePage({ scheme: 'light' });
    const { startTheme, store } = loadController();

    // When
    startTheme();

    // Then
    expect(local.getItem('dotli-theme')).toBeNull();
    expect(root.get('data-theme-pref')).toBe('system');
    expect(root.get('data-theme')).toBe('light');
    expect(store.get()).toEqual({ preference: 'system', resolved: 'light' });
  });

  it('As a returning dotli user, I open dotli and my stored theme is applied to the page and the store', () => {
    // Given
    const { local, root, loadController } = setupThemePage({ scheme: 'dark' });
    local.setItem('dotli-theme', 'light');
    const { startTheme, store } = loadController();

    // When
    startTheme();

    // Then
    expect(root.get('data-theme-pref')).toBe('light');
    expect(root.get('data-theme')).toBe('light');
    expect(store.get()).toEqual({ preference: 'light', resolved: 'light' });
  });

  it('As a dotli user with an unreadable stored theme, I open dotli and it falls back to the System option, as the head script does', () => {
    // Given
    const { local, root, loadController } = setupThemePage({ scheme: 'dark' });
    local.setItem('dotli-theme', 'sepia');
    const { startTheme } = loadController();

    // When
    startTheme();

    // Then
    expect(root.get('data-theme-pref')).toBe('system');
    expect(root.get('data-theme')).toBe('dark');
  });

  it('As a returning user, I see the theme I chose, stored as its plain name', () => {
    // Given a choice made in an earlier visit
    const { local, root, loadController } = setupThemePage({ scheme: 'dark' });
    const earlier = loadController();
    earlier.startTheme();
    earlier.selectThemePref('light');

    // When the page loads again
    const { startTheme, store } = loadController();
    startTheme();

    // Then
    expect(local.getItem('dotli-theme')).toBe('light');
    expect(root.get('data-theme-pref')).toBe('light');
    expect(store.get()).toEqual({ preference: 'light', resolved: 'light' });
  });

  it('As a user with a stored theme from an older build that does not parse, I see the system theme', () => {
    // Given
    const { local, root, loadController } = setupThemePage({ scheme: 'light' });
    local.setItem('dotli-theme', 'auto');
    const { startTheme, store } = loadController();

    // When
    startTheme();

    // Then
    expect(root.get('data-theme-pref')).toBe('system');
    expect(store.get()).toEqual({ preference: 'system', resolved: 'light' });
  });

  it('As a dotli user whose browser blocks storage, I open dotli and the theme falls back to System and follows the OS', () => {
    // Given
    const { os, root, loadController } = setupThemePage({ scheme: 'light', blocked: true });
    const { startTheme, store } = loadController();

    // When
    startTheme();

    // Then
    expect(root.get('data-theme-pref')).toBe('system');
    expect(store.get()).toEqual({ preference: 'system', resolved: 'light' });

    // When
    os.set('dark');

    // Then
    expect(root.get('data-theme')).toBe('dark');
    expect(store.get()).toEqual({ preference: 'system', resolved: 'dark' });
  });

  it('As a dotli user whose browser blocks storage, I select a theme and it still applies', () => {
    // Given
    const { root, loadController } = setupThemePage({ scheme: 'light', blocked: true });
    const { startTheme, selectThemePref, store } = loadController();
    startTheme();

    // When
    selectThemePref('dark');

    // Then
    expect(root.get('data-theme-pref')).toBe('dark');
    expect(root.get('data-theme')).toBe('dark');
    expect(store.get()).toEqual({ preference: 'dark', resolved: 'dark' });
  });

  it('As a dotli integrator, I listen to the theme store and startTheme publishes the OS theme through it', () => {
    // Given: a light OS, as the store starts dark.
    const { loadController } = setupThemePage({ scheme: 'light' });
    const { startTheme, store } = loadController();
    const onThemeChanged = vi.fn();
    onTestFinished(store.listen(onThemeChanged));

    // When
    startTheme();

    // Then
    expect(onThemeChanged).toHaveBeenCalledTimes(1);
  });

  it('As a dotli user, I select Dark and it applies and persists', () => {
    // Given
    const { local, root, loadController } = setupThemePage({ scheme: 'light' });
    local.setItem('dotli-theme', 'light');
    const { startTheme, selectThemePref, store } = loadController();
    startTheme();
    const onThemeChanged = vi.fn();
    onTestFinished(store.listen(onThemeChanged));

    // When
    selectThemePref('dark');

    // Then
    expect(local.getItem('dotli-theme')).toBe('dark');
    expect(root.get('data-theme-pref')).toBe('dark');
    expect(root.get('data-theme')).toBe('dark');
    expect(store.get()).toEqual({ preference: 'dark', resolved: 'dark' });
    expect(onThemeChanged).toHaveBeenCalledTimes(1);
  });

  it('As a dotli user, I select System and the theme resolves from the OS, with no choice left stored', () => {
    // Given
    const { local, root, loadController } = setupThemePage({ scheme: 'light' });
    local.setItem('dotli-theme', 'dark');
    const { startTheme, selectThemePref } = loadController();
    startTheme();

    // When
    selectThemePref('system');

    // Then
    expect(local.getItem('dotli-theme')).toBeNull();
    expect(root.get('data-theme-pref')).toBe('system');
    expect(root.get('data-theme')).toBe('light');
  });

  it('As a dotli user on the System option, I change the OS theme and the page follows it', () => {
    // Given
    const { os, local, root, loadController } = setupThemePage({ scheme: 'dark' });
    local.setItem('dotli-theme', 'system');
    const { startTheme, store } = loadController();
    let changes = 0;
    onTestFinished(
      store.listen(() => {
        changes += 1;
      }),
    );
    startTheme();
    const changesAfterInit = changes;

    // When
    os.set('light');

    // Then
    expect(root.get('data-theme')).toBe('light');
    expect(changes).toBe(changesAfterInit + 1);
  });

  it('As a dotli user on an explicit theme, I change the OS theme and the page keeps mine', () => {
    // Given
    const { os, local, root, loadController } = setupThemePage({ scheme: 'light' });
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

  it('As a dotli user, I pick System after an explicit theme and OS changes are followed again', () => {
    // Given
    const { os, local, root, loadController } = setupThemePage({ scheme: 'dark' });
    local.setItem('dotli-theme', 'light');
    const { startTheme, selectThemePref } = loadController();
    startTheme();
    selectThemePref('system');

    // When
    os.set('light');

    // Then
    expect(root.get('data-theme')).toBe('light');
  });

  it('As a returning visitor on the prerendered page, I load the theme controller and the store reads my stored choice while the root waits for startTheme', () => {
    // Given Light chosen in an earlier visit, on a light OS, which nothing has asked yet
    const { local, root, loadController } = setupThemePage({ scheme: 'light' });
    local.setItem('dotli-theme', 'light');

    // When
    const { store } = loadController();

    // Then
    expect(store.get()).toEqual({ preference: 'light', resolved: 'light' });
    expect(root.has('data-theme')).toBe(false);
  });

  it('As a user on Dark with a light OS, I pick System before the shell starts and am told light once', () => {
    // Given Dark chosen in an earlier visit, on a light OS, before the shell starts the theme
    const { local, loadController } = setupThemePage({ scheme: 'light' });
    local.setItem('dotli-theme', 'dark');
    const { selectThemePref, store } = loadController();
    const heard: ThemeState[] = [];
    onTestFinished(
      store.listen(theme => {
        heard.push(theme);
      }),
    );

    // When
    selectThemePref('system');

    // Then
    expect(heard).toEqual([{ preference: 'system', resolved: 'light' }]);
  });

  it('As a dotli user, I stop the theme and it no longer follows the OS', () => {
    // Given a System theme that follows the OS
    const { os, local, root, loadController } = setupThemePage({ scheme: 'dark' });
    local.setItem('dotli-theme', 'system');
    const { startTheme, store } = loadController();
    const stop = startTheme();

    // When the theme stops, and the OS turns light
    stop();
    os.set('light');

    // Then
    expect(root.get('data-theme')).toBe('dark');
    expect(store.get()).toEqual({ preference: 'system', resolved: 'dark' });
  });
});

/** Builds a fresh page, with the OS on `scheme`. */
function setupThemePage({ scheme, blocked = false }: Params): ThemePage {
  const local = blocked ? createBlockedStorage() : createMemoryStorage();
  const os = createFakeColorScheme({ scheme });
  const root = new Map<string, string>();
  return {
    local,
    os,
    root,
    loadController() {
      const theme = createThemeState({ storage: local });
      const controller = createThemeController({
        theme,
        colorScheme: () => os,
        root: () => ({
          setAttribute(name: string, value: string) {
            root.set(name, value);
          },
        }),
      });
      return { ...controller, store: theme.store };
    },
  };
}
