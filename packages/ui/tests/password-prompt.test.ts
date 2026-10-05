// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from 'vitest';
import { showPasswordPrompt } from '../src/password-prompt.js';
import { ERRORS } from '../src/errors.js';
import { failAllModals } from '../src/state/modals.js';
import { settle } from './helpers/solid.js';
import { overlaysReady, resetOverlays } from './helpers/overlays.js';
import { byTestId, query } from './support.js';

afterEach(() => {
  resetOverlays();
  document.body.replaceChildren();
});

function type(value: string): void {
  const input = byTestId('password-prompt-input', document, HTMLInputElement);
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('password prompt', () => {
  it('As a dotli user, I see the encrypted-content prompt and unlock with my password', async () => {
    // Given
    const password = showPasswordPrompt();
    await overlaysReady();

    // Then
    expect(query(byTestId('signing-modal'), 'h2').textContent).toBe('Encrypted Content');
    expect(document.querySelector('[data-testid="permission-modal-icon"] svg')).not.toBeNull();
    expect(byTestId('password-prompt-hint').textContent).toBe(
      'This content is password-protected. Enter the password to decrypt.',
    );
    expect(document.querySelector('[data-testid="password-prompt-error"]')).toBeNull();

    // When
    type('hunter2');
    await settle();
    byTestId('signing-btn-sign').click();

    // Then
    await expect(password).resolves.toBe('hunter2');
  });

  it('As a dotli user who typed a wrong password, I see the error and can cancel', async () => {
    // Given
    const password = showPasswordPrompt({ error: 'Wrong password' });
    await overlaysReady();

    // Then
    expect(byTestId('password-prompt-error').textContent).toBe('Wrong password');
    expect(byTestId('signing-btn-cancel').dataset['variant']).toBe('secondary');

    // When
    byTestId('signing-btn-cancel').click();

    // Then
    await expect(password).rejects.toThrow(ERRORS.DECRYPTION_CANCELLED);
  });

  it('As a dotli user, if the prompt cannot be shown the sandbox gets a cancellation', async () => {
    // Given
    const password = showPasswordPrompt();

    // When
    failAllModals();

    // Then
    await expect(password).rejects.toThrow(ERRORS.DECRYPTION_CANCELLED);
  });
});
