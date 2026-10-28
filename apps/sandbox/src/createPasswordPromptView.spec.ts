// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { LockIcon } from '@dotli/ui/icons';
import { createPasswordPromptView } from './createPasswordPromptView.js';

describe('password prompt dialog', () => {
  it('As a dotli user, I see the encrypted-content prompt with a password field and the backdrop does not dismiss it', () => {
    // Given no earlier attempt

    // When
    const view = createPasswordPromptView();

    // Then
    expect(view.icon).toBe(LockIcon);
    expect(view.input?.kind).toBe('password');
    expect(view.dismissOnBackdrop).toBe(false);
  });

  it('As a dotli user who typed a wrong password, I see the error and can cancel or unlock', () => {
    // Given the error a wrong password showed
    const options = { error: 'Wrong password' };

    // When
    const view = createPasswordPromptView(options);

    // Then
    expect(view.input?.error).toBe('Wrong password');
    expect(view.buttons.map(button => [button.label, button.variant, button.result])).toEqual([
      ['Cancel', 'cancel', 'cancel'],
      ['Unlock', 'primary', 'unlock'],
    ]);
  });

  it('As a dotli user on a first attempt, I see the prompt and it shows no error', () => {
    // Given an empty error, as a first attempt has
    const options = { error: '' };

    // When
    const view = createPasswordPromptView(options);

    // Then
    expect(view.input).not.toHaveProperty('error');
  });

  it("As the sandbox's integrator, I build the password dialog and it carries the sandbox's own test id", () => {
    // Given no earlier attempt

    // When
    const view = createPasswordPromptView();

    // Then
    expect(view.testId).toBe('password-prompt');
  });
});
