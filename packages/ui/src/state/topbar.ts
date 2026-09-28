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

/**
 * Also dispatches `topbar:visibility` with the boolean as detail. An
 * unchanged value does nothing: no write, no event.
 */
export function setTopbarVisible(visible: boolean): void {
  // The auto-hide reveals on every mouseenter, visible or not. The event's
  // only listener (the chat panel) cares about changes alone.
  if (topbar.get().visible === visible) {
    return;
  }
  topbar.set({ ...topbar.get(), visible });
  window.dispatchEvent(
    new CustomEvent<boolean>("topbar:visibility", { detail: visible }),
  );
}

/** Also dispatches `dotli:blocking-modal-active` with `{ active }`. */
export function setBlockingModalActive(active: boolean): void {
  topbar.set({ ...topbar.get(), blockingModalActive: active });
  window.dispatchEvent(
    new CustomEvent("dotli:blocking-modal-active", { detail: { active } }),
  );
}

export function recordChainsButtonVisible(visible: boolean): void {
  topbar.set({ ...topbar.get(), chainsButtonVisible: visible });
}
