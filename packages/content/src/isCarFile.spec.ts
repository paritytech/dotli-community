// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { isCarFile } from './isCarFile.js';

describe('isCarFile', () => {
  it.each([
    ['an empty response', new Uint8Array(0)],
    ['a response under 10 bytes', new Uint8Array(9)],
    ['random bytes', crypto.getRandomValues(new Uint8Array(64))],
    ['an HTML page', new TextEncoder().encode('<!DOCTYPE html><html>')],
  ])('As a sandbox loading a product, I get %s and do not read it as a CAR archive', (_label, bytes) => {
    // When
    const result = isCarFile(bytes);

    // Then
    expect(result).toBe(false);
  });

  it('As a sandbox loading a product, I get a valid CAR v1 header and read it as a CAR archive', () => {
    // Given
    const header = new Uint8Array([
      0x33, // varint header length = 51
      0xa2, // CBOR: map(2)
      0x65, // CBOR: text(5)
      0x72,
      0x6f,
      0x6f,
      0x74,
      0x73, // "roots"
      0x81, // CBOR: array(1)
      0xd8,
      0x2a, // CBOR: tag(42)
      // Padding up to the 52 bytes the length claims.
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
    ]);

    // When
    const result = isCarFile(header);

    // Then
    expect(result).toBe(true);
  });
});
