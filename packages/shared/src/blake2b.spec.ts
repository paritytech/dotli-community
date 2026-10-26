// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { blake2b } from './blake2b.js';
import { toHex } from './hex.js';

describe('blake2b', () => {
  it('As a deriver of an address checksum, I hash empty input to 32 bytes and get the published BLAKE2b-256 vector', () => {
    // Given an empty input
    const input = new Uint8Array();

    // When it is hashed to 32 bytes
    const digest = blake2b(input, 32);

    // Then the digest is the published vector
    expect(toHex(digest)).toBe('0x0e5751c026e543b2e8ab2eb06099daa1d1e5df47778f7787faab45cdf12fe3a8');
  });

  it('As a deriver of an address checksum, I hash empty input to 64 bytes and get the published BLAKE2b-512 vector', () => {
    // Given an empty input
    const input = new Uint8Array();

    // When it is hashed to 64 bytes
    const digest = blake2b(input, 64);

    // Then the digest is the published vector
    expect(toHex(digest)).toBe(
      '0x786a02f742015903c6c6fd852552d272912f4740e15847618a86e217f71f5419d25e1031afee585313896444934eb04b903a685b1448b755d56f701afe9be2ce',
    );
  });
});
