// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { Tuple, u8 } from 'scale-ts';
import { describe, expect, it } from 'vitest';
import { codec } from './codec.js';

const text = codec<string>(
  value => new TextEncoder().encode(value),
  bytes => new TextDecoder().decode(bytes),
);

describe('codec', () => {
  it('As a schema author, I wrap plain functions as a codec and the library encodes and decodes through them', () => {
    // Given
    const wrapped = text;

    // When
    const bytes = wrapped.enc('hello');

    // Then
    expect([...bytes]).toEqual([104, 101, 108, 108, 111]);
    expect(wrapped.dec(bytes)).toBe('hello');
  });

  it('As a schema author, I decode my payload after other fields and my decode gets exactly the rest of the input', () => {
    // Given
    const message = Tuple(u8, text);
    const bytes = message.enc([7, 'tail']);

    // When
    const decoded = message.dec(bytes);

    // Then
    expect([...bytes]).toEqual([7, 0x74, 0x61, 0x69, 0x6c]);
    expect(decoded).toEqual([7, 'tail']);
  });

  it('As a schema author, I throw from my decode and the library rethrows my own error', () => {
    // Given
    const thrown = new RangeError('not a note');
    const broken = codec<string>(
      () => new Uint8Array(0),
      () => {
        throw thrown;
      },
    );

    // When
    const decode = () => broken.dec(new Uint8Array([1]));

    // Then
    expect(decode).toThrow(thrown);
  });
});
