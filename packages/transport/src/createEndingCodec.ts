// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createCodec, type Codec } from 'scale-ts';
import { createWholeDecoder } from './createWholeDecoder.js';

/**
 * `codec` for a frame variant that ends before the frame does, so it refuses the bytes after it. Every other variant
 * ends in bytes that take the rest of the frame, so it can leave none unread.
 */
export function createEndingCodec<Value>(codec: Codec<Value>): Codec<Value> {
  return createCodec(codec.enc, createWholeDecoder(codec));
}
