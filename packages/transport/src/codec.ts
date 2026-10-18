// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

declare const brand: unique symbol;

/** An opaque byte codec for one value type. Build one with `codec`; only the library reads it. */
export interface Codec<T> {
  readonly [brand]: T;
}

interface CodecImpl<T> {
  encode(value: T): Uint8Array;
  decode(bytes: Uint8Array): T;
}

/** Wraps plain encode and decode functions as a codec. */
export function codec<T>(encode: (value: T) => Uint8Array, decode: (bytes: Uint8Array) => T): Codec<T> {
  const impl: CodecImpl<T> = { encode, decode };
  return impl as unknown as Codec<T>;
}

export function encodeValue<T>(c: Codec<T>, value: T): Uint8Array {
  return (c as unknown as CodecImpl<T>).encode(value);
}

export function decodeValue<T>(c: Codec<T>, bytes: Uint8Array): T {
  return (c as unknown as CodecImpl<T>).decode(bytes);
}

/** The codec of an empty payload. Decoding refuses any byte. */
// eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- an empty payload decodes to void by contract
export const none: Codec<void> = codec<void>(
  () => new Uint8Array(0),
  bytes => {
    if (bytes.length > 0) {
      throw new Error(`expected an empty payload, got ${String(bytes.length)} bytes`);
    }
  },
);
