// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, onSettled } from 'solid-js';
import type { ReadableAtom } from 'nanostores';
import { useStore } from '@dotli/stores-solid';
import type { ThemePreference } from '../runtime/state/themeState.js';
import type { SettingsActions } from '../createSettingsActions.js';
import type { createSettingsIntent } from '../createSettingsIntent.js';
import type { SavedSettings } from '../components/settings/settings.js';
import type { SettingsContentProps } from '../components/settings/SettingsContent.js';
import type { SettingsItemProps } from '../components/settings/SettingsItem.js';

/** The page's settings and theme, and what acts on them. */
export type SettingsBinding = {
  /** Null until boot has read them. */
  settings: ReadableAtom<SavedSettings | null>;
  theme: ReadableAtom<{ preference: ThemePreference }>;
  selectTheme: SettingsContentProps['onTheme'];
  /** The page's settings save and reset. The reset never returns to `idle`. */
  actions: Pick<SettingsActions, 'applyAndReset' | 'reset'>;
  /** How the page's Open settings reaches the panel. */
  intent: Pick<ReturnType<typeof createSettingsIntent>, 'registerOpener'>;
  version: SettingsContentProps['version'];
  debugMode: SettingsContentProps['debugMode'];
  openDebugMode: SettingsContentProps['onDebugMode'];
};

/** The settings button's props, for an island's own lifetime. The page's Open settings opens it. */
export function useSettingsPanel(binding: SettingsBinding): SettingsItemProps {
  const [open, setOpen] = createSignal(false);
  // Once mounted, so an Open settings asked before then opens the panel with its button in place.
  onSettled(() =>
    binding.intent.registerOpener(() => {
      setOpen(true);
    }),
  );
  return {
    open,
    onOpenChange: setOpen,
    settings: useStore(binding.settings),
    version: binding.version,
    theme: useStore(binding.theme, theme => theme.preference, {
      initial: { preference: 'system' } as const,
    }),
    onTheme: binding.selectTheme,
    onApply: binding.actions.applyAndReset,
    reset: useStore(binding.actions.reset, { initial: 'idle' }),
    debugMode: binding.debugMode,
    onDebugMode: binding.openDebugMode,
  };
}
