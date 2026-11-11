// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { createPasswordPromptView } from './createPasswordPromptView.js';

describe('password prompt dialog', () => {
  it('As a dotli user on a first attempt, I see the prompt and it shows no error', () => {
    // Given an empty error, as a first attempt has
    const options = { error: '' };

    // When
    const view = createPasswordPromptView(options);

    // Then
    expect(view.input).not.toHaveProperty('error');
  });
});
