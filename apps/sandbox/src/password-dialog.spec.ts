// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { LockIcon } from '@dotli/ui/icons';
import { passwordPromptDialog } from './password-dialog.js';

describe('password prompt dialog', () => {
  it('As a dotli user, I see the encrypted-content prompt with a password field, which the backdrop does not dismiss', () => {
    // When
    const view = passwordPromptDialog();

    // Then
    expect(view.title).toBe('Encrypted Content');
    expect(view.icon).toBe(LockIcon);
    expect(view.input).toEqual({
      kind: 'password',
      placeholder: 'Password',
      hint: 'This content is password-protected. Enter the password to decrypt.',
    });
    expect(view.dismissOnBackdrop).toBe(false);
  });

  it('As a dotli user who typed a wrong password, I see the error and can cancel or unlock', () => {
    // When
    const view = passwordPromptDialog({ error: 'Wrong password' });

    // Then
    expect(view.input?.error).toBe('Wrong password');
    expect(view.buttons.map(b => [b.label, b.variant, b.result])).toEqual([
      ['Cancel', 'cancel', 'cancel'],
      ['Unlock', 'primary', 'unlock'],
    ]);
  });

  it('As a dotli user on a first attempt, an empty error shows none', () => {
    // When
    const view = passwordPromptDialog({ error: '' });

    // Then
    expect(view.input).not.toHaveProperty('error');
  });
});
