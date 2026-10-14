// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { fromHex, toHex } from './hex.js';

describe('hex', () => {
  it('As a reader of a storage value, I decode hex with or without its 0x prefix to the same bytes', () => {
    // Then
    expect(fromHex('0x0a0b')).toEqual(new Uint8Array([10, 11]));
    expect(fromHex('0a0b')).toEqual(new Uint8Array([10, 11]));
  });

  it('As a writer of a storage key, I encode bytes as 0x-prefixed lowercase hex', () => {
    // Then
    expect(toHex(new Uint8Array([10, 255]))).toBe('0x0aff');
  });

  it('As a reader of a malformed value, I get an error rather than wrong bytes', () => {
    // Then
    expect(() => fromHex('0xabc')).toThrow();
  });
});
