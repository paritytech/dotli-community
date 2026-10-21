// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The password dialog's view. It reaches the page through the page UI chunk.

import { LockIcon } from '@dotli/ui/icons';
import type { ModalView } from '@dotli/ui';

/** `unlock` carries the typed password. */
export type PasswordDecision = 'cancel' | 'unlock';

/**
 * The dialog that asks for a decryption password, showing why the attempt before failed. The backdrop does not
 * dismiss it, since encrypted content has no fallback.
 */
export function passwordPromptDialog(opts?: { error?: string }): ModalView<PasswordDecision> {
  return {
    icon: LockIcon,
    title: 'Encrypted Content',
    testId: 'password-prompt',
    fields: [],
    input: {
      kind: 'password',
      placeholder: 'Password',
      hint: 'This content is password-protected. Enter the password to decrypt.',
      ...(opts?.error !== undefined && opts.error !== '' ? { error: opts.error } : {}),
    },
    buttons: [
      { label: 'Cancel', variant: 'cancel', result: 'cancel' },
      { label: 'Unlock', variant: 'primary', result: 'unlock' },
    ],
    dismissOnBackdrop: false,
  };
}
