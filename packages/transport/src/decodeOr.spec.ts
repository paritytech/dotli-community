// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { str } from 'scale-ts';
import { describe, expect, it } from 'vitest';
import { decodeOr } from './decodeOr.js';

describe('decodeOr', () => {
  it('As a decoder site, I decode bad bytes and onError hears the error and I get undefined', () => {
    // Given a decoder that throws an error, and one that throws a value that is no error
    const refused = new RangeError('these bytes do not decode');
    // A decoder of someone else's may throw anything, which the site must still hear as an error
    const thrownText: unknown = 'not bytes';
    const errors: Error[] = [];
    function refuse(): string {
      throw refused;
    }
    function refuseWithText(): string {
      throw thrownText;
    }

    // When
    const decoded = [
      decodeOr({ decoder: refuse, data: Uint8Array.of(1), onError: error => errors.push(error) }),
      decodeOr({ decoder: refuseWithText, data: Uint8Array.of(1), onError: error => errors.push(error) }),
    ];

    // Then
    expect(decoded).toEqual([undefined, undefined]);
    expect(errors[0]).toBe(refused);
    expect(errors[1]).toBeInstanceOf(Error);
    expect(errors[1]?.cause).toBe('not bytes');
  });

  it('As a decoder site, I decode good bytes and get the value, and onError hears nothing', () => {
    // Given
    const errors: Error[] = [];

    // When
    const decoded = decodeOr({ decoder: str.dec, data: str.enc('a note'), onError: error => errors.push(error) });

    // Then
    expect(decoded).toBe('a note');
    expect(errors).toEqual([]);
  });
});
