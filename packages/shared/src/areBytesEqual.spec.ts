// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { areBytesEqual } from './areBytesEqual.js';

describe('areBytesEqual', () => {
  it('As a developer, I compare two keys and only the same bytes in the same order are equal', () => {
    // Given a key
    const key = Uint8Array.of(1, 2, 3);

    // When it is compared with the same, reordered and longer bytes
    const same = areBytesEqual(key, Uint8Array.of(1, 2, 3));
    const reordered = areBytesEqual(key, Uint8Array.of(3, 2, 1));
    const longer = areBytesEqual(key, Uint8Array.of(1, 2, 3, 0));

    // Then only the same bytes are equal
    expect([same, reordered, longer]).toEqual([true, false, false]);
  });
});
