// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { openModal, type ModalView } from '@dotli/ui';

/** What the prompt rejects with when no password was given. */
export const DECRYPTION_CANCELLED = 'User cancelled decryption';

/** Shows `view`, a password dialog whose `unlock` answer carries the password, and resolves with that password. */
export async function showPasswordPrompt(
  view: ModalView<'cancel' | 'unlock'>,
  present: typeof openModal = openModal,
): Promise<string> {
  const outcome = await present(view);
  if (outcome.result !== 'unlock' || outcome.value === undefined || outcome.value === '') {
    throw new Error(DECRYPTION_CANCELLED);
  }
  return outcome.value;
}
