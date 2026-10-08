// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { decodeHeaderNumber } from '../src/header-number.js';
import { headerHex } from './header-hex.js';

describe('decodeHeaderNumber', () => {
  it('As the network panel, I read the block number in every compact width', () => {
    // Given
    const numbers = [0, 63, 64, 16_383, 16_384, 2 ** 30 - 1, 2 ** 30, 2 ** 32 - 1];

    // When
    const decoded = numbers.map(n => decodeHeaderNumber(headerHex(n)));

    // Then
    expect(decoded).toEqual(numbers);
  });

  it('As the network panel, bytes that are not a header give no number', () => {
    // Then
    expect(decodeHeaderNumber('0x1234')).toBeNull();
    expect(decodeHeaderNumber(`0x${'00'.repeat(32)}zz`)).toBeNull();
    // Big-integer mode wider than a u32.
    expect(decodeHeaderNumber(`0x${'00'.repeat(32)}07${'ff'.repeat(5)}`)).toBeNull();
  });
});
