// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { LockIcon } from '@dotli/ui/icons';
import type { ModalView } from '@dotli/ui';

/** `unlock` carries the typed password. */
export type PasswordDecision = 'cancel' | 'unlock';

/**
 * The view of the dialog that asks for a decryption password, showing `error`, why the attempt before failed, when
 * given. The backdrop does not dismiss it, since encrypted content has no fallback. Never throws.
 */
export function createPasswordPromptView(options?: { error?: string }): ModalView<PasswordDecision> {
  return {
    icon: LockIcon,
    title: 'Encrypted Content',
    testId: 'password-prompt',
    fields: [],
    input: {
      kind: 'password',
      placeholder: 'Password',
      hint: 'This content is password-protected. Enter the password to decrypt.',
      ...(options?.error === undefined ? {} : { error: options.error }),
    },
    buttons: [
      { label: 'Cancel', variant: 'cancel', result: 'cancel' },
      { label: 'Unlock', variant: 'primary', result: 'unlock' },
    ],
    dismissOnBackdrop: false,
  };
}
