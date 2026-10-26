// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { getErrorMessage } from './getErrorMessage.js';

describe('getErrorMessage', () => {
  it('As a page showing a failure, I read the message of an Error and a thrown string as it is', () => {
    // Given
    const failure = new Error('Failed to fetch', { cause: new Error('dns') });

    // When
    const read = [getErrorMessage(failure), getErrorMessage('boom'), getErrorMessage(42)];

    // Then
    expect(read).toEqual(['Failed to fetch', 'boom', '42']);
  });
});
