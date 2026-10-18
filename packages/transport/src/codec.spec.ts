// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { Tuple, u8 } from 'scale-ts';
import { describe, expect, it } from 'vitest';
import { codec, none, scaleOf } from './codec.js';

const text = codec<string>(
  value => new TextEncoder().encode(value),
  bytes => new TextDecoder().decode(bytes),
);

describe('codec', () => {
  it('As a schema author, I wrap plain functions as a codec and the library encodes and decodes through them', () => {
    // Given
    const wrapped = scaleOf(text);

    // When
    const bytes = wrapped.enc('hello');

    // Then
    expect([...bytes]).toEqual([104, 101, 108, 108, 111]);
    expect(wrapped.dec(bytes)).toBe('hello');
  });

  it('As a schema author, my decode gets the rest of the input after what precedes it, and the read ends there', () => {
    // Given
    const message = Tuple(u8, scaleOf(text), scaleOf(none));
    const bytes = message.enc([7, 'tail', undefined]);

    // When
    const decoded = message.dec(bytes);

    // Then
    expect([...bytes]).toEqual([7, 0x74, 0x61, 0x69, 0x6c]);
    expect(decoded).toEqual([7, 'tail', undefined]);
  });

  it('As a schema author, I use none for an empty payload and it refuses any byte', () => {
    // Given
    const empty = scaleOf(none);

    // When
    const bytes = empty.enc(undefined);

    // Then
    expect(bytes.length).toBe(0);
    // The call is wrapped only because lint forbids using a void value inside an expression.
    expect(() => {
      empty.dec(new Uint8Array(0));
    }).not.toThrow();
    for (const payload of [[0], [1, 2, 3]]) {
      expect(() => {
        empty.dec(new Uint8Array(payload));
      }).toThrow(`got ${String(payload.length)} bytes`);
    }
  });
});
