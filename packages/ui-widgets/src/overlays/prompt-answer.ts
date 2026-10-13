// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ModalView } from '@dotli/ui-core';

/** What a press on the scrim or Escape answers, or nothing for a prompt that must be answered. */
export function scrimAnswer<R extends string>(view: ModalView<R>): R | undefined {
  return view.dismissOnBackdrop ? view.dismissResult : undefined;
}

/**
 * What the sheet's close button answers. It always answers, so no prompt shape leaves a dead button: the scrim's
 * answer, else the prompt's Cancel, else its danger reject.
 */
export function closeAnswer<R extends string>(view: ModalView<R>): R | undefined {
  return (
    scrimAnswer(view) ??
    (view.buttons.find(b => b.variant === 'cancel') ?? view.buttons.find(b => b.variant === 'danger'))?.result
  );
}
