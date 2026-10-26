// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSyncStore, shallowEqual, type ReadableStore } from '@dotli/shared';

export type TopbarState = {
  /** The host's topbar, which the sandbox app's page lacks. */
  present: boolean;
  visible: boolean;
  /** The bar carries the reveal shortcut and the reveal control shows. */
  autoHide: boolean;
  blockingModalActive: boolean;
  /** Prompts queued behind the one on screen. */
  blockingModalsWaiting: number;
};

function initialState(): TopbarState {
  return { present: false, visible: true, autoHide: false, blockingModalActive: false, blockingModalsWaiting: 0 };
}

const topbar = createSyncStore<TopbarState>('topbar', initialState(), { equals: shallowEqual });

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

/** The runtime's blocking modal queue reports here how many prompts wait and whether one shows. */
export function reportBlockingModals({ waiting, active }: { waiting: number; active: boolean }): void {
  topbar.set({ ...topbar.get(), blockingModalsWaiting: waiting, blockingModalActive: active });
}
