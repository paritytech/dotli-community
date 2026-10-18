// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { Bytes, Struct, str, u64, u8, type Decoder } from 'scale-ts';
import { describe, expect, it } from 'vitest';
import {
  decodeExact,
  f64,
  nullable,
  oneOf,
  safeInteger,
  strictBool,
  strictOption,
  u32Exact,
  u8Exact,
  WireDecodeError,
} from './codec-primitives.js';

function toBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}

describe('codec primitives', () => {
  it('As a sender, I encode safe integers and they arrive exactly', () => {
    for (const value of [0, 2 ** 32, Date.now() + 90_000, Number.MAX_SAFE_INTEGER]) {
      // Given
      const sent = safeInteger.enc(value);

      // When
      const received = decodeExact(safeInteger.dec, toBuffer(sent));

      // Then
      expect(received).toBe(value);
    }
  });

  it('As a sender, I cannot encode an integer the wire would distort', () => {
    // Given
    const distorted = [1.5, -1, 2 ** 53];
    const outsideU32 = [2 ** 32, 0.5, -1, Number.NaN];
    const outsideU8 = [256, -1, 1.5];

    // When / Then
    for (const value of distorted) {
      expect(() => safeInteger.enc(value)).toThrow(RangeError);
    }
    for (const value of outsideU32) {
      expect(() => u32Exact.enc(value)).toThrow(RangeError);
    }
    for (const value of outsideU8) {
      expect(() => u8Exact.enc(value)).toThrow(RangeError);
    }
  });

  it('As a receiver, I refuse a u64 beyond the safe integers', () => {
    // Given
    const tooLarge = u64.enc(BigInt(Number.MAX_SAFE_INTEGER) + 1n);

    // When / Then
    expect(() => decodeExact(safeInteger.dec, toBuffer(tooLarge))).toThrow(RangeError);
  });

  it('As a sender, I send any finite number as f64 and it arrives unchanged', () => {
    for (const value of [1.5, 1e20, 2 ** 60]) {
      // Given
      const sent = f64.enc(value);

      // When
      const received = decodeExact(f64.dec, toBuffer(sent));

      // Then
      expect(received).toBe(value);
    }
  });

  it('As a sender, I send null and it arrives as null', () => {
    // Given
    const codec = nullable(str);

    // When
    const received = [null, 'x'].map(value => decodeExact(codec.dec, toBuffer(codec.enc(value))));

    // Then
    expect(received).toEqual([null, 'x']);
  });

  it('As a receiver, I decode an option, a nullable or a bool whose tag is neither 0 nor 1 and refuse it', () => {
    // Given a tag of 2, then what an option of a string would read as an empty string
    const tagged = toBuffer(Uint8Array.of(2, 0));
    const options: Decoder<unknown>[] = [strictOption(str).dec, nullable(str).dec];

    // When / Then
    for (const decoder of options) {
      expect(() => decodeExact(decoder, tagged)).toThrow(WireDecodeError);
      expect(() => decodeExact(decoder, tagged)).toThrow('the option could not be decoded');
    }
    expect(() => decodeExact(strictBool.dec, toBuffer(u8.enc(2)))).toThrow(new RangeError('2 is not a bool'));
  });

  it('As a receiver, I decode an option holding a bool byte of 2 and refuse it with the bool check as the cause', () => {
    // Given
    const option = strictOption(strictBool);

    // When
    let caught: unknown;
    try {
      decodeExact(option.dec, toBuffer(Uint8Array.of(1, 2)));
    } catch (error) {
      caught = error;
    }

    // Then
    expect(caught).toBeInstanceOf(WireDecodeError);
    expect(caught).toMatchObject({
      message: 'the option could not be decoded',
      cause: new RangeError('2 is not a bool'),
    });
  });

  it('As a sender, I send options and bools and they arrive as sent', () => {
    // Given
    const option = strictOption(str);

    // When
    const encoded = [undefined, 'x'].map(value => [...option.enc(value)]);
    const options = [undefined, 'x'].map(value => decodeExact(option.dec, toBuffer(option.enc(value))));
    const bools = [true, false].map(value => decodeExact(strictBool.dec, toBuffer(strictBool.enc(value))));

    // Then
    expect(encoded).toEqual([[0], [1, 4, 0x78]]);
    expect(options).toEqual([undefined, 'x']);
    expect(bools).toEqual([true, false]);
  });

  it('As a receiver, I refuse a truncated value', () => {
    // Given
    const codec = Struct({ a: str, b: Bytes() });
    const sent = codec.enc({ a: 'hello', b: new Uint8Array([1, 2, 3]) });

    // When / Then
    expect(() => decodeExact(codec.dec, toBuffer(sent.subarray(0, sent.byteLength - 1)))).toThrow();
  });

  it('As a receiver, I refuse trailing bytes', () => {
    // Given
    const codec = Struct({ a: str, b: Bytes() });
    const sent = codec.enc({ a: 'hello', b: new Uint8Array([1, 2, 3]) });
    const padded = new Uint8Array(sent.byteLength + 1);
    padded.set(sent);

    // When / Then
    expect(() => decodeExact(codec.dec, toBuffer(padded))).toThrow();
  });

  it('As a receiver, I decode an index past the list and refuse it', () => {
    // Given
    const codec = oneOf(['a', 'b']);

    // When / Then
    expect(() => decodeExact(codec.dec, toBuffer(u8.enc(5)))).toThrow(WireDecodeError);
    expect(() => decodeExact(codec.dec, toBuffer(u8.enc(5)))).toThrow('the listed value could not be decoded');
  });

  it('As a sender, I send listed values that look like integers and each keeps its place in the list', () => {
    // Given
    const values = ['b', '1', 'a', '0'] as const;
    const codec = oneOf(values);

    // When
    const sent = values.map(value => [...codec.enc(value)]);

    // Then
    expect(sent).toEqual([[0], [1], [2], [3]]);
    expect(decodeExact(codec.dec, toBuffer(u8.enc(1)))).toBe('1');
  });

  it('As a schema author, I list a value twice and am refused, since its index would be ambiguous', () => {
    // Given
    const values = ['a', 'a', 'b'];

    // When / Then
    expect(() => oneOf(values)).toThrow(new RangeError('the value "a" is listed twice'));
  });

  it('As a sender, I send one of the listed values as its index and it arrives as sent', () => {
    // Given
    const codec = oneOf(['a', 'b', 'c']);

    // When
    const sent = codec.enc('c');

    // Then
    expect([...sent]).toEqual([2]);
    expect(decodeExact(codec.dec, toBuffer(sent))).toBe('c');
  });

  it('As a sender, I send a value outside the list and am refused with the list', () => {
    // Given
    const codec = oneOf<string>(['a', 'b']);

    // When / Then
    expect(() => codec.enc('z')).toThrow(new RangeError('"z" is not one of a, b'));
  });
});
