// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { codec, decodeValue, encodeValue, none } from './codec.js';

describe('codec', () => {
  it('As a schema author, I wrap plain functions as a codec and the library encodes and decodes through them', () => {
    // Given
    const text = codec<string>(
      value => new TextEncoder().encode(value),
      bytes => new TextDecoder().decode(bytes),
    );

    // When
    const bytes = encodeValue(text, 'hello');

    // Then
    expect([...bytes]).toEqual([104, 101, 108, 108, 111]);
    expect(decodeValue(text, bytes)).toBe('hello');
  });

  it('As a schema author, I use none for an empty payload and it refuses any byte', () => {
    // Given
    const empty = new Uint8Array(0);

    // When
    const bytes = encodeValue(none, undefined);

    // Then
    expect(bytes.length).toBe(0);
    expect(() => {
      decodeValue(none, empty);
    }).not.toThrow();
    expect(() => {
      decodeValue(none, new Uint8Array([0]));
    }).toThrow();
  });
});
