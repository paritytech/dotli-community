// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Answers the dialog the modal store shows, as the dialog's buttons and backdrop would, so a spec presents a prompt
// on the page's dialog queue in place of the overlays.

import { modals, type ModalEntry } from './createModals.js';

/** The dialog on screen, which is the first one queued. Throws when none is. */
export function shownModal(): ModalEntry {
  const entry = modals.store.get()[0];
  if (entry === undefined) {
    throw new Error('expected a dialog on screen, none is');
  }
  return entry;
}

/**
 * Presses the shown dialog's button with this label, with `value` as what its input holds. Throws when no dialog is on
 * screen or it has no such button.
 */
export function chooseModalButton(label: string, value?: string): void {
  const { id, view } = shownModal();
  const button = view.buttons.find(candidate => candidate.label === label);
  if (button === undefined) {
    const labels = view.buttons.map(candidate => candidate.label).join(', ');
    throw new Error(`expected a "${label}" button, the dialog has ${labels}`);
  }
  modals.settle(id, button.result, { value });
}

/** A backdrop click or Escape, which settles only a dialog that allows it. Throws when no dialog is on screen. */
export function dismissModal(): void {
  const { id, view } = shownModal();
  if (view.dismissOnBackdrop && view.dismissResult !== undefined) {
    modals.settle(id, view.dismissResult);
  }
}
