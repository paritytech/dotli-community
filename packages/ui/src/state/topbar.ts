// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSyncStore, shallowEqual, type ReadableStore } from './create-store.js';

export interface TopbarState {
  /** The page has the topbar: the host's, not the sandbox app's. */
  present: boolean;
  visible: boolean;
  /**
   * The bar auto-hides (topbar-autohide.ts): it carries the reveal shortcut,
   * and the reveal control shows.
   */
  autoHide: boolean;
  /** The landing page is up: it has its own account and theme buttons. */
  landing: boolean;
  blockingModalActive: boolean;
  chainsButtonVisible: boolean;
  /**
   * The Settings panel is open. SettingsPopover writes it as the panel opens
   * and closes, and opens the panel when openSettings() sets it.
   */
  settingsOpen: boolean;
}

const topbar = createSyncStore<TopbarState>(
  {
    present: false,
    visible: true,
    autoHide: false,
    landing: false,
    blockingModalActive: false,
    chainsButtonVisible: false,
    settingsOpen: false,
  },
  { equals: shallowEqual },
);

export const topbarStore: ReadableStore<TopbarState> = topbar;
export const getTopbarState = topbar.get;

/** The host's topbar is on the page (initTopBar). */
export function setTopbarPresent(): void {
  topbar.set({ ...topbar.get(), present: true });
}

/** The auto-hide reveals on every mouseenter: an unchanged value notifies nobody. */
export function setTopbarVisible(visible: boolean): void {
  topbar.set({ ...topbar.get(), visible });
}

export function setTopbarAutoHide(autoHide: boolean): void {
  topbar.set({ ...topbar.get(), autoHide });
}

/** The landing page took the page over (landing/load.ts). */
export function setLandingPage(): void {
  topbar.set({ ...topbar.get(), landing: true });
}

export function setBlockingModalActive(active: boolean): void {
  topbar.set({ ...topbar.get(), blockingModalActive: active });
}

export function recordChainsButtonVisible(visible: boolean): void {
  topbar.set({ ...topbar.get(), chainsButtonVisible: visible });
}

/**
 * Open the topbar's Settings panel, as its button does: for a control
 * outside the bar that sends the visitor there (an error page's "Open
 * settings").
 */
export function openSettings(): void {
  setSettingsOpen(true);
}

/** The Settings panel opened or closed (SettingsPopover). */
export function setSettingsOpen(settingsOpen: boolean): void {
  topbar.set({ ...topbar.get(), settingsOpen });
}
