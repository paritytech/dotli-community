// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { Tuple, u8 } from 'scale-ts';
import { describe, expect, it } from 'vitest';
import { codec, none, scaleOf, type Codec } from './codec.js';

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

  it('As a schema author, I decode my payload after other fields and my decode gets exactly the rest of the input', () => {
    // Given
    const message = Tuple(u8, scaleOf(text), scaleOf(none));
    const bytes = message.enc([7, 'tail', undefined]);

    // When
    const decoded = message.dec(bytes);

    // Then
    expect([...bytes]).toEqual([7, 0x74, 0x61, 0x69, 0x6c]);
    expect(decoded).toEqual([7, 'tail', undefined]);
  });

  it('As a schema author, I throw from my decode and the library rethrows my own error', () => {
    // Given
    const thrown = new RangeError('not a note');
    const broken = scaleOf(
      codec<string>(
        () => new Uint8Array(0),
        () => {
          throw thrown;
        },
      ),
    );

    // When
    let caught: unknown;
    try {
      broken.dec(new Uint8Array([1]));
    } catch (error) {
      caught = error;
    }

    // Then
    expect(caught).toBe(thrown);
  });

  it('As a schema author, I can only pass a codec built by codec where a codec is due', () => {
    // Given
    const built: Codec<string> = text;

    // When
    // @ts-expect-error an empty object is no codec, so a schema cannot hold one by mistake
    const empty: Codec<string> = {};

    // Then
    expect(scaleOf(built).enc('a')).toEqual(Uint8Array.of(0x61));
    expect(empty).toEqual({});
  });

  it('As a schema author, I use none for an empty payload and it reads no byte', () => {
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
  });
});
