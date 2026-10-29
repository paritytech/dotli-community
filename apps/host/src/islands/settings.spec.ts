// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from 'vitest';
import { createRoot, flush } from 'solid-js';
import { createSyncStore } from '@dotli/shared';
import { resetAllStoresForTests } from '@dotli/shared/testing';
import type { ThemePreference } from '../runtime/state/themeState.js';
import type { SavedSettings } from '../components/settings/settings.js';
import { createSettingsIntent } from '../createSettingsIntent.js';
import { useSettingsPanel } from './settings.js';

type Params = {
  /** The intent the panel opens through, a fresh one by default. */
  intent?: ReturnType<typeof createSettingsIntent>;
};

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

/**
 * The page's settings and theme, as boot left them, and the panel's props read from them under a fresh owner, opened
 * through `intent`.
 */
function mount({ intent = createSettingsIntent() }: Params = {}) {
  const settings = createSyncStore<SavedSettings | null>({ name: 'settings-test-settings', initial: null });
  const theme = createSyncStore<{ preference: ThemePreference }>({
    name: 'settings-test-theme',
    initial: { preference: 'system' },
  });
  const { panel, dispose } = createRoot(d => ({
    panel: useSettingsPanel({
      settings,
      theme,
      selectTheme: () => undefined,
      apply: () => Promise.resolve(),
      registerOpener: intent.registerOpener,
      version: '1.2.3',
      debugMode: () => false,
      openDebugMode: () => undefined,
    }),
    dispose: d,
  }));
  flush();
  return { panel, dispose, settings, theme, intent };
}

describe('useSettingsPanel', () => {
  it('As a visitor whose load failed, an Open settings asked before the button mounted opens it once mounted', () => {
    // Given
    const intent = createSettingsIntent();
    intent.open();

    // When
    const { panel, dispose } = mount({ intent });

    // Then
    expect(panel.open()).toBe(true);
    dispose();
  });

  it('As a visitor, Open settings opens the panel I closed, and stops reaching it once the button is gone', () => {
    // Given
    const { panel, dispose, intent } = mount();
    panel.onOpenChange(false);
    flush();

    // When
    intent.open();
    flush();

    // Then
    expect(panel.open()).toBe(true);

    // When
    dispose();
    panel.onOpenChange(false);
    intent.open();
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
    theme.set({ preference: 'dark' });
    flush();

    // Then
    expect(panel.settings()).toEqual(SAVED);
    expect(panel.theme()).toBe('dark');
    expect(panel.version).toBe('1.2.3');
    dispose();
  });
});
