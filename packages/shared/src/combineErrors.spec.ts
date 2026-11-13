// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { combineErrors } from './combineErrors.js';

describe('combineErrors', () => {
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
