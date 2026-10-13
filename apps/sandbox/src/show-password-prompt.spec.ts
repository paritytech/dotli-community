// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from 'vitest';
import { chooseModalButton, resetModalsForTests, shownModal } from '@dotli/ui-core/testing';
import { failAllModals, type ModalView, openModal } from '@dotli/ui-core';
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
  fallbackResult: 'cancel',
};

afterEach(() => {
  resetModalsForTests();
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

  it('As a dotli user, if the prompt cannot be shown the sandbox gets a cancellation', async () => {
    // Given
    const password = showPasswordPrompt(LOCKED, openModal);

    // When
    failAllModals();

    // Then
    await expect(password).rejects.toThrow(DECRYPTION_CANCELLED);
  });
});
