// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { Bytes, enhanceCodec, type Codec } from 'scale-ts';

/** Wraps plain encode and decode functions as a codec. A payload ends its message, so it takes the rest of the bytes. */
export function codec<T>(encode: (value: T) => Uint8Array, decode: (bytes: Uint8Array) => T): Codec<T> {
  return enhanceCodec(Bytes(Infinity), encode, decode);
}
