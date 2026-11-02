// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { combineErrors } from './combineErrors.js';

describe('combineErrors', () => {
  it('As a dotli integrator, I combine one error and get that error back', () => {
    // Given one error
    const error = new Error('a');

    // When it is combined
    const combined = combineErrors([error], 'closing failed');

    // Then the result is that same error
    expect(combined).toBe(error);
  });

  it('As a dotli integrator, I combine several errors and get an AggregateError of all of them with my message', () => {
    // Given two errors
    const first = new Error('a');
    const second = new Error('b');

    // When they are combined
    const combined = combineErrors([first, second], 'closing failed');

    // Then the result is an AggregateError of both, in order, with the given message
    expect(combined).toBeInstanceOf(AggregateError);
    expect(combined).toHaveProperty('errors', [first, second]);
    expect(combined.message).toBe('closing failed');
  });

  it('As a dotli integrator, I combine one thrown value that is not an Error and get it wrapped', () => {
    // Given one thrown value that is not an Error
    const thrown = 'boom';

    // When it is combined
    const combined = combineErrors([thrown], 'closing failed');

    // Then the result is an AggregateError that holds it
    expect(combined).toBeInstanceOf(AggregateError);
    expect(combined).toHaveProperty('errors', ['boom']);
  });
});
