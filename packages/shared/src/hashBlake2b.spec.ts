// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { hashBlake2b } from './hashBlake2b.js';
import { toHex } from './hex.js';

describe('hashBlake2b', () => {
  it('As a deriver of an address checksum, I hash empty input to 32 bytes and get the published BLAKE2b-256 vector', () => {
    // Given an empty input
    const input = new Uint8Array();

    // When it is hashed to 32 bytes
    const digest = hashBlake2b(input, 32);

    // Then the digest is the published vector
    expect(toHex(digest)).toBe('0x0e5751c026e543b2e8ab2eb06099daa1d1e5df47778f7787faab45cdf12fe3a8');
  });
});
