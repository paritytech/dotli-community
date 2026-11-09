// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, onTestFinished } from 'vitest';
import { createRoot, flush } from 'solid-js';
import { atom, type WritableAtom } from 'nanostores';
import { resetAllStoresForTests } from '@dotli/shared/testing';
import type { ThemePreference } from '../runtime/state/themeState.js';
import type { SavedSettings, SettingsResetStatus } from '../components/settings/settings.js';
import { createSettingsIntent } from '../createSettingsIntent.js';
import { useSettingsPanel } from './settings.js';

type Params = {
  /** The intent the panel opens through, a fresh one by default. */
  intent?: ReturnType<typeof createSettingsIntent>;
  /** The page's settings reset, idle by default. */
  reset?: WritableAtom<SettingsResetStatus>;
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
function mount({ intent = createSettingsIntent(), reset = atom<SettingsResetStatus>('idle') }: Params = {}) {
  const settings = atom<SavedSettings | null>(null);
  const theme = atom<{ preference: ThemePreference }>({ preference: 'system' });
  const { panel, dispose } = createRoot(d => ({
    panel: useSettingsPanel({
      settings,
      theme,
      selectTheme: () => undefined,
      apply: () => Promise.resolve(),
      reset,
      registerOpener: intent.registerOpener,
      version: '1.2.3',
      debugMode: () => false,
      openDebugMode: () => undefined,
    }),
    dispose: d,
  }));
  flush();
  return { panel, dispose, settings, theme, intent, reset };
}

describe('useSettingsPanel', () => {
  it('As a visitor whose load failed, an Open settings asked before the button mounted opens it once mounted', () => {
    // Given an Open settings asked before the button mounted
    const intent = createSettingsIntent();
    intent.open();

    // When the settings button mounts
    const { panel, dispose } = mount({ intent });
    onTestFinished(dispose);

    // Then the panel is open
    expect(panel.open()).toBe(true);
  });

  it('As a visitor, Open settings opens the panel I closed, and stops reaching it once the button is gone', () => {
    // Given a mounted settings button whose panel I closed
    const { panel, dispose, intent } = mount();
    panel.onOpenChange(false);
    flush();

    // When Open settings is asked
    intent.open();
    flush();

    // Then the panel is open
    expect(panel.open()).toBe(true);

    // When the button is gone, and the panel is closed and asked to open again
    dispose();
    panel.onOpenChange(false);
    intent.open();
    flush();

    // Then the panel stays closed
    expect(panel.open()).toBe(false);
  });

  it('As the settings button, I show no settings and the system theme before boot has read them', () => {
    // Given a page whose boot has not read the settings

    // When the settings button mounts
    const { panel, dispose } = mount();
    onTestFinished(dispose);

    // Then it shows no settings and the system theme
    expect(panel.settings()).toBeNull();
    expect(panel.theme()).toBe('system');
  });

  it("As the settings button, I follow the page's reset once it starts clearing", () => {
    // Given a panel bound to an idle reset
    const { panel, reset, dispose } = mount();
    onTestFinished(dispose);

    // When the page's reset starts clearing
    reset.set('clearing');
    flush();

    // Then the panel reads it
    expect(panel.reset()).toBe('clearing');
  });

  it('As the settings button, I follow the settings once boot has read them, and the theme the page applies', () => {
    // Given a mounted settings button
    const { panel, dispose, settings, theme } = mount();
    onTestFinished(dispose);

    // When boot reads the settings and the page applies a dark theme
    settings.set(SAVED);
    theme.set({ preference: 'dark' });
    flush();

    // Then the button follows both
    expect(panel.settings()).toEqual(SAVED);
    expect(panel.theme()).toBe('dark');
    expect(panel.version).toBe('1.2.3');
  });
});
