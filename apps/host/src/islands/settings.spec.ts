// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot, flush } from 'solid-js';
import { createSyncStore } from '@dotli/shared';
import { resetAllStoresForTests } from '@dotli/shared/testing';
import type { ThemeChoice } from '@dotli/ui-entities';
import type { SavedSettings } from '../components/settings/settings.js';
import { openSettings, registerSettingsOpener } from '../settings-intent.js';
import { type SettingsBinding, useSettingsPanel } from './settings.js';

const SAVED: SavedSettings = {
  backend: 'smoldot-direct',
  cache: { skipCidCache: false, skipArchiveCache: false, skipWorkerCache: false },
  network: 'paseo-next-v2',
  enabledNetworks: ['paseo-next-v2'],
  sharedWorkerAvailable: true,
  verified: true,
};

afterEach(() => {
  resetAllStoresForTests();
});

/** The page's settings and theme, as boot left them, and the panel's props read from them under a fresh owner. */
function mount(registerOpener: SettingsBinding['registerOpener'] = registerSettingsOpener) {
  const settings = createSyncStore<SavedSettings | null>('settings-test-settings', null);
  const theme = createSyncStore<{ pref: ThemeChoice }>('settings-test-theme', { pref: 'system' });
  const { panel, dispose } = createRoot(d => ({
    panel: useSettingsPanel({
      settings,
      theme,
      selectTheme: () => undefined,
      apply: () => Promise.resolve(),
      registerOpener,
      version: '1.2.3',
      debugMode: () => false,
      openDebugMode: () => undefined,
    }),
    dispose: d,
  }));
  flush();
  return { panel, dispose, settings, theme };
}

describe('useSettingsPanel', () => {
  it('As a visitor whose load failed, an Open settings asked before the button mounted opens it once mounted', () => {
    // Given
    openSettings();

    // When
    const { panel, dispose } = mount();

    // Then
    expect(panel.open()).toBe(true);
    dispose();
  });

  it('As a visitor, Open settings opens the panel I closed, and stops reaching it once the button is gone', () => {
    // Given
    const register = vi.fn(registerSettingsOpener);
    const { panel, dispose } = mount(register);
    panel.onOpenChange(false);
    flush();

    // When
    openSettings();
    flush();

    // Then
    expect(panel.open()).toBe(true);
    expect(register).toHaveBeenCalledTimes(1);

    // When
    dispose();
    panel.onOpenChange(false);
    openSettings();
    flush();

    // Then
    expect(panel.open()).toBe(false);
  });

  it('As the settings button, I follow the settings once boot has read them, and the theme the page applies', () => {
    // Given
    const { panel, dispose, settings, theme } = mount();
    expect(panel.settings()).toBeNull();
    expect(panel.theme()).toBe('system');

    // When
    settings.set(SAVED);
    theme.set({ pref: 'dark' });
    flush();

    // Then
    expect(panel.settings()).toEqual(SAVED);
    expect(panel.theme()).toBe('dark');
    expect(panel.version).toBe('1.2.3');
    dispose();
  });
});
