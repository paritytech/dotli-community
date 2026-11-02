// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { Bytes, Tuple, enhanceDecoder, type Codec, type Decoder } from 'scale-ts';

/**
 * The decoder of `codec` that refuses a value which leaves bytes unread, as truapi's `decode_all` does. Built once per
 * codec, since composing it per message would cost each message the composition.
 */
export function createWholeDecoder<Value>(codec: Codec<Value>): Decoder<Value> {
  return enhanceDecoder(Tuple.dec(codec.dec, Bytes.dec(Infinity)), ([value, rest]) => {
    if (rest.length > 0) {
      throw new RangeError(`The value is followed by unread bytes, ${String(rest.length)} in all`);
    }
    return value;
  });
}
