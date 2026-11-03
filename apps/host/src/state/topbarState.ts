// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { isShallowEqual, registerAtomReset } from '@dotli/shared';
import { atom, type ReadableAtom } from 'nanostores';

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

type Params = {
  /** How many prompts wait behind the one on screen. */
  waiting: number;
  /** Whether a prompt is on screen. */
  active: boolean;
};

const topbar = atom<TopbarState>({
  present: false,
  visible: true,
  autoHide: false,
  blockingModalActive: false,
  blockingModalsWaiting: 0,
});
topbar.eq = isShallowEqual;
registerAtomReset(topbar);
const store: ReadableAtom<TopbarState> = topbar;

/** The topbar's presence, visibility, auto-hide and blocking prompts. */
export const topbarState = {
  /** The topbar's state. Notifies only when a field changes, so a repeated write notifies nobody. */
  store,
  /** Returns the current state. Never throws. */
  get,
  /** Marks the page as one with the host's topbar. Never throws. */
  setPresent,
  /** Shows or hides the bar. Never throws. */
  setVisible,
  /** Turns the bar's auto-hide on or off. Never throws. */
  setAutoHide,
  /** Records how many prompts wait and whether one is on screen. Never throws. */
  reportBlockingModals,
};

function get(): TopbarState {
  return topbar.get();
}

function setPresent(): void {
  topbar.set({ ...topbar.get(), present: true });
}

function setVisible(visible: boolean): void {
  topbar.set({ ...topbar.get(), visible });
}

function setAutoHide(autoHide: boolean): void {
  topbar.set({ ...topbar.get(), autoHide });
}

function reportBlockingModals({ waiting, active }: Params): void {
  topbar.set({ ...topbar.get(), blockingModalsWaiting: waiting, blockingModalActive: active });
}
