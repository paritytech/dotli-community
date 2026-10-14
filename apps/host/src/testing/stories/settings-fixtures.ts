// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The settings and theme a story gives the settings button and panel, and what the views asked of the page. Plays move
// them the way the page's settings store and theme do.

import { createSignal, flush } from 'solid-js';
import { fn } from 'storybook/test';
import type { CacheSettings } from '@dotli/config';
import type { ThemePref } from '../../runtime/state/theme.js';
import type { ApplySettings, SavedSettings } from '../../components/settings/settings.js';
import type { SettingsItemProps } from '../../components/settings/SettingsItem.js';

export const DEFAULT_CACHE: CacheSettings = { skipCidCache: false, skipArchiveCache: false, skipWorkerCache: false };

/** A fresh visitor's settings on a deployment with two networks. */
export const DEFAULT_SETTINGS: SavedSettings = {
  backend: 'smoldot-direct',
  cache: DEFAULT_CACHE,
  network: 'paseo-next-v2',
  enabledNetworks: ['paseo-next-v2', 'previewnet'],
  sharedWorkerAvailable: true,
  verified: true,
};

const [settings, setSettings] = createSignal<SavedSettings | null>(DEFAULT_SETTINGS);
const [theme, setThemeSignal] = createSignal<ThemePref>('system');
const [debugMode, setDebugModeSignal] = createSignal(false);
const [open, setOpenSignal] = createSignal(false);

/** What the views asked of the page. */
export const settingsAsked = {
  /** Stands in for the page's apply, which would wipe storage and reload. */
  apply: fn<ApplySettings>(),
  themes: [] as ThemePref[],
  debugMode: 0,
};

/** The props a page gives the settings button. A theme pick applies as the page's theme would. */
export const storySettings: SettingsItemProps = {
  open,
  onOpenChange: next => {
    setOpenSignal(next);
    flush();
  },
  settings,
  version: '0.0.0',
  theme,
  onTheme: next => {
    settingsAsked.themes.push(next);
    setTheme(next);
  },
  onApply: (...args) => settingsAsked.apply(...args),
  debugMode,
  onDebugMode: () => {
    settingsAsked.debugMode += 1;
  },
};

/** The settings as boot read them, or null before it has. */
export function givenSettings(next: SavedSettings | null): void {
  setSettings(next);
  flush();
}

function setTheme(next: ThemePref): void {
  setThemeSignal(next);
  flush();
}

/** The debug panel is on in this tab. */
export function givenDebugMode(on: boolean): void {
  setDebugModeSignal(on);
  flush();
}

/** For a story's `beforeEach`: the default settings read, the OS theme, closed, nothing asked. */
export function resetStorySettings(): void {
  givenSettings(DEFAULT_SETTINGS);
  setTheme('system');
  givenDebugMode(false);
  setOpenSignal(false);
  flush();
  settingsAsked.apply.mockReset();
  settingsAsked.apply.mockResolvedValue(undefined);
  settingsAsked.themes.length = 0;
  settingsAsked.debugMode = 0;
}
