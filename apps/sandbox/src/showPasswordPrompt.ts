// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { modals, type ModalView } from '@dotli/ui';

import { DecryptionCancelledError } from './errors.js';

type Params = {
  /** Opens the dialog and resolves with the visitor's answer. */
  present?: typeof modals.open;
};

/**
 * Shows `view`, a password dialog whose `unlock` answer carries the password, and resolves with that password. Rejects
 * with a `DecryptionCancelledError` when the visitor cancels or unlocks with no password.
 */
export async function showPasswordPrompt(
  view: ModalView<'cancel' | 'unlock'>,
  { present = modals.open }: Params = {},
): Promise<string> {
  const outcome = await present(view);
  if (outcome.result !== 'unlock' || outcome.value === undefined || outcome.value === '') {
    throw new DecryptionCancelledError();
  }
  return outcome.value;
}
