// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import {
  createSyncStore,
  shallowEqual,
  type ReadableStore,
} from "./create-store";

export interface TopbarState {
  visible: boolean;
  blockingModalActive: boolean;
  chainsButtonVisible: boolean;
}

const topbar = createSyncStore<TopbarState>(
  {
    visible: true,
    blockingModalActive: false,
    chainsButtonVisible: false,
  },
  { equals: shallowEqual },
);

export const topbarStore: ReadableStore<TopbarState> = topbar;
export const getTopbarState = topbar.get;

/** The auto-hide reveals on every mouseenter: an unchanged value notifies nobody. */
export function setTopbarVisible(visible: boolean): void {
  topbar.set({ ...topbar.get(), visible });
}

export function setBlockingModalActive(active: boolean): void {
  topbar.set({ ...topbar.get(), blockingModalActive: active });
}

export function recordChainsButtonVisible(visible: boolean): void {
  topbar.set({ ...topbar.get(), chainsButtonVisible: visible });
}
