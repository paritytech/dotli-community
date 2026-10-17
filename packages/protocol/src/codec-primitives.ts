// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// scale-ts integer encoders write through DataView and silently wrap or truncate, and its decoders read from a
// view's whole buffer. These wrappers refuse what the wire cannot carry exactly.

import { Option, createCodec, createDecoder, enhanceCodec, u32, u64, u8, type Codec, type Decoder } from 'scale-ts';

/** scale-ts hands decoders its internal byte array, which carries the read cursor and a view over the buffer. */
interface Cursor extends Uint8Array {
  i: number;
  v: DataView;
}

const F64_BYTES = 8;

/** `u64` on the wire, throws `RangeError` on anything but an integer in `0..Number.MAX_SAFE_INTEGER`. */
export const safeInteger: Codec<number> = enhanceCodec(
  u64,
  (value: number) => {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`${String(value)} is not a non-negative safe integer`);
    }
    return BigInt(value);
  },
  (value: bigint) => {
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new RangeError(`${String(value)} exceeds the largest safe integer`);
    }
    return Number(value);
  },
);

/** `u32` on the wire, throws `RangeError` outside the integers `0..2**32-1`. */
export const u32Exact: Codec<number> = enhanceCodec(
  u32,
  (value: number) => {
    if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
      throw new RangeError(`${String(value)} is not a u32`);
    }
    return value;
  },
  (value: number) => value,
);

/** Eight bytes little-endian. */
export const f64: Codec<number> = createCodec(
  (value: number) => {
    const bytes = new Uint8Array(F64_BYTES);
    new DataView(bytes.buffer).setFloat64(0, value, true);
    return bytes;
  },
  createDecoder(input => {
    const cursor = input as Cursor;
    const value = cursor.v.getFloat64(cursor.i, true);
    cursor.i += F64_BYTES;
    return value;
  }),
);

/** `Option` on the wire, `null` for none. */
export function nullable<T>(inner: Codec<T>): Codec<T | null> {
  return enhanceCodec<T | undefined, T | null>(
    Option(inner),
    (value: T | null) => value ?? undefined,
    (value: T | undefined) => value ?? null,
  );
}

/** A `u8` index into `values`. An index past the list is a `RangeError`. */
export function oneOf<T extends string>(values: readonly T[]): Codec<T> {
  return enhanceCodec(
    u8,
    (value: T) => {
      const index = values.indexOf(value);
      if (index < 0) {
        throw new RangeError(`${value} is not one of ${values.join(', ')}`);
      }
      return index;
    },
    (index: number) => {
      const value = values[index];
      if (value === undefined) {
        throw new RangeError(`index ${String(index)} is past the ${String(values.length)} known values`);
      }
      return value;
    },
  );
}

/** Decodes on one cursor over the whole buffer and throws unless the value ends exactly at `byteLength`. */
export function decodeExact<T>(decoder: Decoder<T>, data: ArrayBuffer): T {
  return createDecoder(input => {
    const cursor = input as Cursor;
    const value = decoder(cursor);
    if (cursor.i !== cursor.byteLength) {
      throw new RangeError(`decoded ${String(cursor.i)} of ${String(cursor.byteLength)} bytes`);
    }
    return value;
  })(data);
}
