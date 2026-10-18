// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createCodec, createDecoder, type Codec as ScaleCodec } from 'scale-ts';

declare const brand: unique symbol;

/** An opaque byte codec for one value type. Build one with `codec`; only the library reads it. */
export interface Codec<T> {
  readonly [brand]?: (value: T) => T;
}

/** scale-ts hands a decoder its own byte array over the whole buffer, which carries the read position. */
export type Cursor = Uint8Array & { i: number };

// What a user's decode threw. The library names its own decode failures, and passes these on as they were thrown.
const payloadFailures = new WeakSet();

/** Whether a user's decode threw `error`, which the library reports unchanged. */
export function isPayloadFailure(error: unknown): boolean {
  return typeof error === 'object' && error !== null && payloadFailures.has(error);
}

/**
 * Wraps plain encode and decode functions as a codec. A payload is the last field of a message, so the decode gets the
 * rest of the input as a view of the message's buffer, with no copy, and the read ends there.
 */
export function codec<T>(encode: (value: T) => Uint8Array, decode: (bytes: Uint8Array) => T): Codec<T> {
  const scale = createCodec<T>(
    encode,
    createDecoder(input => {
      const cursor = input as Cursor;
      let value: T;
      try {
        value = decode(new Uint8Array(cursor.buffer, cursor.i));
      } catch (error) {
        if (typeof error === 'object' && error !== null) {
          payloadFailures.add(error);
        }
        throw error;
      }
      cursor.i = cursor.byteLength;
      return value;
    }),
  );
  return scale as unknown as Codec<T>;
}

/** The scale-ts codec behind a codec. A library-internal accessor, so it stays out of the index. */
export function scaleOf<T>(c: Codec<T>): ScaleCodec<T> {
  return c as unknown as ScaleCodec<T>;
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
