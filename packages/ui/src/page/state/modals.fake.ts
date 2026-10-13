// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Answers the dialog the modal store shows, as the dialog's buttons and backdrop would, so a spec presents a prompt
// with `openModal` in place of the overlays.

import { modalsStore, settleModal, type ModalEntry } from './modals.js';

/** The dialog on screen, which is the first one queued. */
export function shownModal(): ModalEntry {
  const entry = modalsStore.get()[0];
  if (entry === undefined) {
    throw new Error('expected a dialog on screen, none is');
  }
  return entry;
}

/** Presses the shown dialog's button with this label, with `value` as what its input holds. */
export function chooseModalButton(label: string, value?: string): void {
  const { id, view } = shownModal();
  const button = view.buttons.find(b => b.label === label);
  if (button === undefined) {
    throw new Error(`expected a "${label}" button, the dialog has ${view.buttons.map(b => b.label).join(', ')}`);
  }
  settleModal(id, button.result, value);
}

/** A backdrop click or Escape, which settles only a dialog that allows it. */
export function dismissModal(): void {
  const { id, view } = shownModal();
  if (view.dismissOnBackdrop && view.dismissResult !== undefined) {
    settleModal(id, view.dismissResult);
  }
}
