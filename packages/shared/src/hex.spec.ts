// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { fromHex, toHex } from './hex.js';
import { catchError } from './testing/catchError.js';

describe('hex', () => {
  it('As a reader of a storage value, I decode hex with or without its 0x prefix to the same bytes', () => {
    // When
    const prefixed = fromHex('0x0a0b');
    const bare = fromHex('0a0b');

    // Then
    expect(prefixed).toEqual(new Uint8Array([10, 11]));
    expect(bare).toEqual(new Uint8Array([10, 11]));
  });

  it('As a writer of a storage key, I encode bytes as 0x-prefixed lowercase hex', () => {
    // When
    const encoded = toHex(new Uint8Array([10, 255]));

    // Then
    expect(encoded).toBe('0x0aff');
  });

  it('As a reader of a malformed value, I get an error rather than wrong bytes', () => {
    // When
    const error = catchError(() => fromHex('0xabc'));

    // Then
    expect(error).toBeInstanceOf(Error);
  });
});
