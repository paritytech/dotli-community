// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { toAbortError } from './abort.js';

describe('toAbortError', () => {
  it('As a caller, I reject with the AbortError a signal was aborted with and keep it as is', () => {
    // Given
    const reason = new DOMException('closed', 'AbortError');

    // When
    const error = toAbortError(reason, 'fallback');

    // Then
    expect(error).toBe(reason);
  });

  it('As a caller, I turn a string reason into an AbortError with that message', () => {
    // When
    const error = toAbortError('scope gone', 'fallback');

    // Then
    expect(error.name).toBe('AbortError');
    expect(error.message).toBe('scope gone');
  });

  it('As a caller, I turn any other reason into an AbortError with the fallback message', () => {
    // When
    const error = toAbortError(new DOMException('late', 'TimeoutError'), 'fallback');

    // Then
    expect(error.name).toBe('AbortError');
    expect(error.message).toBe('fallback');
  });
});
