// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { Bytes, enhanceCodec, type Codec } from 'scale-ts';

/**
 * Wraps plain encode and decode functions as a codec. A payload ends its message, so it takes the rest of the bytes.
 *
 * @example
 * const textCodec = codec((text: string) => new TextEncoder().encode(text), bytes => new TextDecoder().decode(bytes));
 */
export function codec<Value>(encode: (value: Value) => Uint8Array, decode: (bytes: Uint8Array) => Value): Codec<Value> {
  return enhanceCodec(Bytes(Infinity), encode, decode);
}
