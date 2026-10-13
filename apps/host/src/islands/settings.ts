// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, onSettled } from 'solid-js';
import type { ReadableStore } from '@dotli/shared';
import { useStore } from '@dotli/ui';
import type { ThemeChoice } from '@dotli/ui-entities';
import type { ApplySettings, SavedSettings } from '../components/settings/settings.js';
import type { SettingsItemProps } from '../components/topbar/items.js';

/** The page's settings and theme, and what acts on them. */
export interface SettingsBinding {
  /** Null until boot has read them. */
  settings: ReadableStore<SavedSettings | null>;
  theme: ReadableStore<{ pref: ThemeChoice }>;
  selectTheme: (theme: ThemeChoice) => void;
  apply: ApplySettings;
  /** How the page's Open settings reaches the panel. Returns the unregister. */
  registerOpener: (open: () => void) => () => void;
  version: string;
  debugMode: () => boolean;
  openDebugMode: () => void;
}

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
    theme: useStore(binding.theme, theme => theme.pref),
    onTheme: binding.selectTheme,
    onApply: binding.apply,
    debugMode: binding.debugMode,
    onDebugMode: binding.openDebugMode,
  };
}
