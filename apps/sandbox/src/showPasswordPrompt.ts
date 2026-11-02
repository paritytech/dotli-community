// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { modals, type ModalView } from '@dotli/ui';

type Params = {
  /** Opens the dialog and resolves with the visitor's answer. */
  present?: typeof modals.open;
};

/** What the prompt rejects with when no password was given. */
export const DECRYPTION_CANCELLED = 'User cancelled decryption';

/**
 * Shows `view`, a password dialog whose `unlock` answer carries the password, and resolves with that password. Rejects
 * with `DECRYPTION_CANCELLED` when the visitor cancels or unlocks with no password.
 */
export async function showPasswordPrompt(
  view: ModalView<'cancel' | 'unlock'>,
  { present = modals.open }: Params = {},
): Promise<string> {
  const outcome = await present(view);
  if (outcome.result !== 'unlock' || outcome.value === undefined || outcome.value === '') {
    throw new Error(DECRYPTION_CANCELLED);
  }
  return outcome.value;
}
