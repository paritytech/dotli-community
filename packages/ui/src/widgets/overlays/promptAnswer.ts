// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ModalButton, ModalView } from '../../page/state/createModals.js';

/** What a press on the scrim or Escape answers, or nothing for a prompt that must be answered. */
export function getScrimAnswer<R extends string>(view: ModalView<R>): R | undefined {
  return view.dismissOnBackdrop ? view.dismissResult : undefined;
}

/**
 * The answer that grants and destroys nothing: the prompt's Cancel, else its danger reject, which only refuses the
 * request. Nothing for a prompt that offers neither.
 */
export function getSafeButton<R extends string>(view: ModalView<R>): ModalButton<R> | undefined {
  return view.buttons.find(b => b.variant === 'cancel') ?? view.buttons.find(b => b.variant === 'danger');
}

/**
 * What the sheet's close button answers. It always answers, so no prompt shape leaves a dead button: the scrim's
 * answer, else the safe answer.
 */
export function getCloseAnswer<R extends string>(view: ModalView<R>): R | undefined {
  return getScrimAnswer(view) ?? getSafeButton(view)?.result;
}
