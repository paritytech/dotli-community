// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, onTestFinished } from 'vitest';
import { createRoot, flush } from 'solid-js';
import { atom } from 'nanostores';
import { resetAllStoresForTests } from '@dotli/shared/testing';
import type { ThemePreference } from '../runtime/state/themeState.js';
import type { SavedSettings, SettingsResetStatus } from '../components/settings/settings.js';
import { createSettingsIntent } from '../createSettingsIntent.js';
import { useSettingsPanel } from './settings.js';

type Params = {
  /** The intent the panel opens through, a fresh one by default. */
  intent?: ReturnType<typeof createSettingsIntent>;
};

afterEach(() => {
  resetAllStoresForTests();
});

/**
 * The page's settings and theme, as boot left them, and the panel's props read from them under a fresh owner, opened
 * through `intent`.
 */
function mount({ intent = createSettingsIntent() }: Params = {}) {
  const reset = atom<SettingsResetStatus>('idle');
  const settings = atom<SavedSettings | null>(null);
  const theme = atom<{ preference: ThemePreference }>({ preference: 'system' });
  const { panel, dispose } = createRoot(d => ({
    panel: useSettingsPanel({
      settings,
      theme,
      selectTheme: () => undefined,
      actions: { applyAndReset: () => Promise.resolve(), reset },
      intent,
      version: '1.2.3',
      debugMode: () => false,
      openDebugMode: () => undefined,
    }),
    dispose: d,
  }));
  flush();
  return { panel, dispose, intent };
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
});
