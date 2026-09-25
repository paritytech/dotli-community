// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSyncStore, type ReadableStore } from "./create-store";

export type ThemePref = "light" | "dark" | "system";

export interface ThemeState {
  pref: ThemePref;
  resolved: "light" | "dark";
}

// Dark is the stylesheet default; the real value is written at boot by the
// topbar, which reads localStorage and matchMedia.
const theme = createSyncStore<ThemeState>({ pref: "system", resolved: "dark" });

export const themeStore: ReadableStore<ThemeState> = theme;
export const getThemeState = theme.get;

/** Also dispatches `dotli:theme-changed`, which the TrUAPI theme bridge forwards. */
export function setTheme(next: ThemeState): void {
  theme.set(next);
  window.dispatchEvent(new Event("dotli:theme-changed"));
}
