// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSyncStore, shallowEqual, type ReadableStore } from './create-store.js';

export interface TopbarState {
  /** The host's topbar, which the sandbox app's page lacks. */
  present: boolean;
  visible: boolean;
  /** The bar carries the reveal shortcut and the reveal control shows. */
  autoHide: boolean;
  blockingModalActive: boolean;
  /** Prompts queued behind the one on screen. */
  blockingModalsWaiting: number;
  /** SettingsPopover writes it as the panel opens and closes, and opens the panel when openSettings() sets it. */
  settingsOpen: boolean;
}

const topbar = createSyncStore<TopbarState>(
  'topbar',
  {
    present: false,
    visible: true,
    autoHide: false,
    blockingModalActive: false,
    blockingModalsWaiting: 0,
    settingsOpen: false,
  },
  { equals: shallowEqual },
);

export const topbarStore: ReadableStore<TopbarState> = topbar;
export const getTopbarState = topbar.get;

export function setTopbarPresent(): void {
  topbar.set({ ...topbar.get(), present: true });
}

/** The auto-hide reveals on every mouseenter, and an unchanged value notifies nobody. */
export function setTopbarVisible(visible: boolean): void {
  topbar.set({ ...topbar.get(), visible });
}

export function setTopbarAutoHide(autoHide: boolean): void {
  topbar.set({ ...topbar.get(), autoHide });
}

export function setBlockingModalActive(active: boolean): void {
  topbar.set({ ...topbar.get(), blockingModalActive: active });
}

export function setBlockingModalsWaiting(blockingModalsWaiting: number): void {
  topbar.set({ ...topbar.get(), blockingModalsWaiting });
}

/** For a control outside the bar that sends the visitor to Settings, such as an error page's. */
export function openSettings(): void {
  setSettingsOpen(true);
}

export function setSettingsOpen(settingsOpen: boolean): void {
  topbar.set({ ...topbar.get(), settingsOpen });
}
