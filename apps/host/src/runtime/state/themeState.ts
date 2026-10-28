// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSyncStore, isShallowEqual, type ReadableStore } from '@dotli/shared';

/** The theme the user chose, where System follows the OS. */
export type ThemePreference = 'light' | 'dark' | 'system';

/** The page's theme. */
export type ThemeState = {
  /** The theme the user chose. */
  preference: ThemePreference;
  /** The theme the page shows, the OS's own for System. */
  resolved: 'light' | 'dark';
};

const theme = createSyncStore<ThemeState>({
  name: 'theme',
  initial: { preference: 'system', resolved: 'dark' },
  equals: isShallowEqual,
});
const store: ReadableStore<ThemeState> = theme;

/** The page's theme preference and the theme it resolves to. */
export const themeState = {
  /** The current theme. A `set` equal to it notifies nobody. */
  store,
  /** Returns the current theme. Never throws. */
  get: theme.get,
  /** Publishes the next theme, dropping one equal to the current. Never throws. */
  set: theme.set,
};
