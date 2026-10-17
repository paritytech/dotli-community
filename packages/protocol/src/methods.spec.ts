// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { METHOD_NAMES, PROTOCOL_METHODS } from './methods.js';

describe('protocol methods', () => {
  it('As the protocol, I give every method a distinct wire id', () => {
    // Given
    const names = METHOD_NAMES;

    // When
    const distinct = new Set(names);

    // Then
    expect(distinct.size).toBe(names.length);
    expect(names.length).toBe(Object.keys(PROTOCOL_METHODS).length);
    expect(names.length).toBeLessThanOrEqual(256);
    expect(names[0]).toBe('handshake');
  });
});
