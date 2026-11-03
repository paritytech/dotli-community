// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, onSettled } from 'solid-js';
import type { ReadableAtom } from 'nanostores';
import { useStore } from '@dotli/stores-solid';
import type { ThemePreference } from '../runtime/state/themeState.js';
import type { ApplySettings, SavedSettings } from '../components/settings/settings.js';
import type { SettingsItemProps } from '../components/settings/SettingsItem.js';

/** The page's settings and theme, and what acts on them. */
export type SettingsBinding = {
  /** Null until boot has read them. */
  settings: ReadableAtom<SavedSettings | null>;
  theme: ReadableAtom<{ preference: ThemePreference }>;
  selectTheme: (theme: ThemePreference) => void;
  apply: ApplySettings;
  /** How the page's Open settings reaches the panel. Returns the unregister. */
  registerOpener: (open: () => void) => () => void;
  version: string;
  debugMode: () => boolean;
  openDebugMode: () => void;
};

/** The settings button's props, for an island's own lifetime. The page's Open settings opens it. */
export function useSettingsPanel(binding: SettingsBinding): SettingsItemProps {
  const [open, setOpen] = createSignal(false);
  // Once mounted, so an Open settings asked before then opens the panel with its button in place.
  onSettled(() =>
    binding.registerOpener(() => {
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
    onApply: binding.apply,
    debugMode: binding.debugMode,
    onDebugMode: binding.openDebugMode,
  };
}
