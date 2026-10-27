// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { decodeHeaderNumber } from './decodeHeaderNumber.js';
import { encodeHeaderHex } from './testing/encodeHeaderHex.js';

describe('decodeHeaderNumber', () => {
  it.each([0, 63, 64, 16_383, 16_384, 2 ** 30 - 1, 2 ** 30, 2 ** 32 - 1])(
    'As the network panel, I read the block number %i in its compact width',
    blockNumber => {
      // Given
      const header = encodeHeaderHex(blockNumber);

      // When
      const decoded = decodeHeaderNumber(header);

      // Then
      expect(decoded).toBe(blockNumber);
    },
  );

  it.each([
    { kind: 'too short', hex: '0x1234' },
    { kind: 'not hex', hex: `0x${'00'.repeat(32)}zz` },
    { kind: 'big-integer mode wider than a u32', hex: `0x${'00'.repeat(32)}07${'ff'.repeat(5)}` },
  ])('As the network panel, I read no number from bytes that are not a header: $kind', ({ hex }) => {
    // When
    const decoded = decodeHeaderNumber(hex);

    // Then
    expect(decoded).toBeNull();
  });
});
