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

    // When / Then
    for (const value of distorted) {
      expect(() => safeInteger.enc(value)).toThrow(RangeError);
    }
    for (const value of outsideU32) {
      expect(() => u32Exact.enc(value)).toThrow(RangeError);
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

  it('As a receiver, I refuse an option, a nullable or a bool whose tag is neither 0 nor 1', () => {
    // Given
    const decoders: Decoder<unknown>[] = [strictOption(str).dec, nullable(str).dec, strictBool.dec];

    // When / Then
    for (const decoder of decoders) {
      expect(() => decodeExact(decoder, toBuffer(u8.enc(2)))).toThrow(RangeError);
    }
  });

  it('As a sender, I send options and bools and they arrive as sent', () => {
    // Given
    const option = strictOption(str);

    // When
    const options = [undefined, 'x'].map(value => decodeExact(option.dec, toBuffer(option.enc(value))));
    const bools = [true, false].map(value => decodeExact(strictBool.dec, toBuffer(strictBool.enc(value))));

    // Then
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

  it('As a receiver, I refuse an unknown index', () => {
    // Given
    const codec = oneOf(['a', 'b']);

    // When / Then
    expect(() => decodeExact(codec.dec, toBuffer(u8.enc(5)))).toThrow(RangeError);
  });
});
