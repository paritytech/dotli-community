// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from 'vitest';
import { resetAllStoresForTests } from '@dotli/shared/testing';
import { chooseModalButton, shownModal } from '@dotli/ui/testing';
import { type ModalView, openModal } from '@dotli/ui';
import { DECRYPTION_CANCELLED, showPasswordPrompt } from './show-password-prompt.js';

/** A password dialog as the app builds one. Its copy is the app's. */
const LOCKED: ModalView<'cancel' | 'unlock'> = {
  title: 'Locked',
  fields: [],
  input: { kind: 'password', placeholder: 'Password' },
  buttons: [
    { label: 'Cancel', variant: 'cancel', result: 'cancel' },
    { label: 'Unlock', variant: 'primary', result: 'unlock' },
  ],
  dismissOnBackdrop: false,
};

afterEach(() => {
  resetAllStoresForTests();
});

describe('password prompt', () => {
  it('As a dotli user, I see the password dialog and unlock with my password', async () => {
    // Given
    const password = showPasswordPrompt(LOCKED, openModal);

    // Then
    expect(shownModal().view).toBe(LOCKED);

    // When
    chooseModalButton('Unlock', 'hunter2');

    // Then
    await expect(password).resolves.toBe('hunter2');
  });

  it('As a dotli user who cancels, the sandbox gets a cancellation', async () => {
    // Given
    const password = showPasswordPrompt(LOCKED, openModal);

    // When
    chooseModalButton('Cancel');

    // Then
    await expect(password).rejects.toThrow(DECRYPTION_CANCELLED);
  });

  it('As a dotli user who unlocks with an empty field, the sandbox gets a cancellation', async () => {
    // Given
    const password = showPasswordPrompt(LOCKED, openModal);

    // When
    chooseModalButton('Unlock', '');

    // Then
    await expect(password).rejects.toThrow(DECRYPTION_CANCELLED);
  });
});
