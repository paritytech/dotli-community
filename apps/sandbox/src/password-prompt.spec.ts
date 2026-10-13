// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import type { ModalView } from '@dotli/ui-core';
import type { PasswordDialogModule } from './lazy.js';
import { createPasswordPrompt } from './password-prompt.js';

/** The dialog's chunk, titling each view with the error it shows. */
const DIALOG: PasswordDialogModule = {
  passwordPromptDialog: options => ({
    title: options?.error ?? 'Locked',
    fields: [],
    buttons: [],
    dismissOnBackdrop: false,
    fallbackResult: 'cancel',
  }),
};

/** A dialog chunk that counts its loads, and the views the page was asked to show, each answered with `secret`. */
function page(load: () => Promise<PasswordDialogModule> = () => Promise.resolve(DIALOG)) {
  const loads = { count: 0 };
  const shown: ModalView<'cancel' | 'unlock'>[] = [];
  const prompt = createPasswordPrompt({
    load: () => {
      loads.count += 1;
      return load();
    },
    show: view => {
      shown.push(view);
      return Promise.resolve('secret');
    },
  });
  return { prompt, loads, shown };
}

describe('password prompt', () => {
  it('As a visitor opening encrypted content, the dialog starts loading before the prompt, and loads once', async () => {
    // Given
    const { prompt, loads, shown } = page();

    // When
    prompt.prepare();

    // Then
    expect(loads.count).toBe(1);

    // When
    const password = await prompt.prompt({ error: 'Wrong password' });

    // Then
    expect(password).toBe('secret');
    expect(loads.count).toBe(1);
    expect(shown.map(view => view.title)).toEqual(['Wrong password']);
  });

  it('As a visitor, a prompt with nothing prepared loads the dialog itself', async () => {
    // Given
    const { prompt, loads } = page();

    // When
    const password = await prompt.prompt();

    // Then
    expect(password).toBe('secret');
    expect(loads.count).toBe(1);
  });

  it('As a visitor whose dialog chunk failed, the prompt rejects with the load error and shows nothing', async () => {
    // Given
    const failure = new Error('Failed to fetch dynamically imported module');
    const { prompt, shown } = page(() => Promise.reject(failure));

    // When
    prompt.prepare();
    const password = prompt.prompt();

    // Then
    await expect(password).rejects.toBe(failure);
    expect(shown).toEqual([]);
  });
});
