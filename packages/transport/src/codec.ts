// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { Bytes, _void, enhanceCodec, type Codec as ScaleCodec } from 'scale-ts';

declare const brand: unique symbol;

/** An opaque byte codec for one value type. Build one with `codec`; only the library reads it. */
export interface Codec<T> {
  readonly [brand]: (value: T) => T;
}

/** Wraps plain encode and decode functions as a codec. A payload ends its message, so it takes the rest of the bytes. */
export function codec<T>(encode: (value: T) => Uint8Array, decode: (bytes: Uint8Array) => T): Codec<T> {
  return enhanceCodec(Bytes(Infinity), encode, decode) as unknown as Codec<T>;
}

/** The codec of an empty payload. */
export const none: Codec<void> = _void as unknown as Codec<void>;

/** The scale-ts codec behind a codec. A library-internal accessor, so it stays out of the index. */
export const scaleOf = <T>(c: Codec<T>): ScaleCodec<T> => c as unknown as ScaleCodec<T>;
