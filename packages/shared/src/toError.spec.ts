// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { toError } from './toError.js';

describe('toError', () => {
  it('As a caller rejecting with what was thrown, I convert it and an Error passes through while anything else becomes the cause of a new one', () => {
    // Given
    const failure = new TypeError('closed');
    const thrown = { code: 7 };

    // When
    const passed = toError(failure);
    const wrapped = toError(thrown);

    // Then
    expect(passed).toBe(failure);
    expect(wrapped).toBeInstanceOf(Error);
    expect(wrapped.message).toBe('{"code":7}');
    expect(wrapped.cause).toBe(thrown);
  });
});
