// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What scale-ts lacks for the protocol's values. Its integer encoders write through DataView and silently wrap or
// truncate, its `Option` and `bool` read any non-zero byte as present or true, it has no float, and it decodes with no
// check that the value ends where the data does. These codecs refuse what the wire cannot carry exactly.

import {
  Enum,
  _void,
  createCodec,
  createDecoder,
  enhanceCodec,
  u32,
  u64,
  u8,
  type Codec,
  type Decoder,
  type StringRecord,
} from 'scale-ts';

/** scale-ts hands decoders its internal byte array, which carries the read cursor and a view over the buffer. */
interface Cursor extends Uint8Array {
  i: number;
  v: DataView;
}

const F64_BYTES = 8;

/** Data a protocol codec cannot read. The scale-ts failure is its cause. */
export class WireDecodeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'WireDecodeError';
  }
}

// The transport keeps its scale-ts helpers private, since its codecs are opaque, so the protocol has its own wrapper.
/** Names a decode failure in `what`, keeping it as the cause. A failure already named passes unchanged. */
function named<T>(c: Codec<T>, what: string): Codec<T> {
  return createCodec(
    c.enc,
    createDecoder(input => {
      try {
        return c.dec(input);
      } catch (cause) {
        if (cause instanceof WireDecodeError) {
          throw cause;
        }
        throw new WireDecodeError(`${what} could not be decoded`, { cause });
      }
    }),
  );
}

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

/** `u8` on the wire, throws `RangeError` outside the integers `0..255`. */
export const u8Exact: Codec<number> = enhanceCodec(
  u8,
  (value: number) => {
    if (!Number.isInteger(value) || value < 0 || value > 0xff) {
      throw new RangeError(`${String(value)} is not a u8`);
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

/** `bool` on the wire, throws `RangeError` on a byte other than 0 or 1. */
export const strictBool: Codec<boolean> = enhanceCodec(
  u8,
  (value: boolean) => (value ? 1 : 0),
  (byte: number) => {
    if (byte > 1) {
      throw new RangeError(`${String(byte)} is not a bool`);
    }
    return byte === 1;
  },
);

/** `Option` on the wire as the enum it is, so a tag other than 0 or 1 is refused. */
export function strictOption<T>(inner: Codec<T>): Codec<T | undefined> {
  return named(
    enhanceCodec(
      Enum({ none: _void, some: inner }),
      (value: T | undefined) =>
        value === undefined ? { tag: 'none' as const, value: undefined } : { tag: 'some' as const, value },
      decoded => (decoded.tag === 'some' ? decoded.value : undefined),
    ),
    'the option',
  );
}

/** A strict `Option` on the wire, `null` for none. */
export function nullable<T>(inner: Codec<T>): Codec<T | null> {
  return enhanceCodec<T | undefined, T | null>(
    strictOption(inner),
    (value: T | null) => value ?? undefined,
    (value: T | undefined) => value ?? null,
  );
}

/**
 * An enum of unit variants, each at its place in `values`, read as its tag. An index past the list is refused, and so
 * is a value listed twice, whose index would be ambiguous.
 */
export function oneOf<T extends string>(values: readonly T[]): Codec<T> {
  values.forEach((value, index) => {
    if (values.indexOf(value) !== index) {
      throw new RangeError(`the value "${value}" is listed twice`);
    }
  });
  const variants = Object.fromEntries(values.map(value => [value, _void])) as StringRecord<Codec<undefined>>;
  // An object lists integer-like keys first, so each variant is pinned to its place in the list.
  const indices = Object.keys(variants).map(key => values.indexOf(key as T));
  const listed = enhanceCodec(
    Enum(variants, indices as unknown as Parameters<typeof Enum>[1]),
    (value: T) => ({ tag: value, value: undefined }),
    ({ tag }) => tag as T,
  );
  const decoded = named(listed, 'the listed value');
  return createCodec((value: T) => {
    try {
      return listed.enc(value);
    } catch (cause) {
      throw new RangeError(`"${value}" is not one of ${values.join(', ')}`, { cause });
    }
  }, decoded.dec);
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
