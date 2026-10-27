// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { fromHex } from '@dotli/shared';
import {
  computeNamehash,
  computeMappingSlot,
  computeBytesDataSlot,
  addToSlot,
  readWordAsBigInt,
  extractAddress,
  decodeBytesSlot,
} from './storageSlots.js';

describe('computeNamehash', () => {
  // eth and foo.eth are well-known ENS test vectors.
  it.each([
    ['the empty name', '32 zero bytes', '', '0x0000000000000000000000000000000000000000000000000000000000000000'],
    ['eth', 'the ENS test vector', 'eth', '0x93cdeb708b7545dc668eb9280176169d1c33cfd8ed6f04690a0bcc88a93fc4ae'],
    ['foo.eth', 'the ENS test vector', 'foo.eth', '0xde9b09fd7c5f901e23a3f19fecc54828e9c848539801e86591bd9801b019f84f'],
  ])('As the resolver reading dotNS storage, I hash %s to %s', (_name, _outcome, name, expected) => {
    // When
    const hash = computeNamehash(name);

    // Then
    expect(hash).toBe(expected);
  });
});

describe('computeMappingSlot', () => {
  // Pinned from an independent keccak256(abi.encode(key, slot)) over @noble/hashes, outside the repo code.
  const key1 = '0x0000000000000000000000000000000000000000000000000000000000000001';
  const key2 = '0x0000000000000000000000000000000000000000000000000000000000000002';

  it.each([
    [
      'a key in the first mapping',
      'keccak256 of the key and the slot',
      '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      0,
      '0xe99c1dcfc4ac025ecbc3952f42d94d3271d3a0e61c6752073ec8c7a4080f12b8',
    ],
    [
      'key 1 in the first mapping',
      'its own slot',
      key1,
      0,
      '0xada5013122d395ba3c54772283fb069b10426056ef8ca54750cb9bb552a59e7d',
    ],
    [
      'key 2 in the first mapping',
      'a slot apart from key 1',
      key2,
      0,
      '0xabbb5caa7dda850e60932de0934eb1f9d0f59695050f761dc64e443e5030a569',
    ],
    [
      'key 1 in the second mapping',
      'the slot number hashed in',
      key1,
      1,
      '0xcc69885fda6bcc1a4ace058b4a62bf5e179ea78fd58a1ccd71c22cc9b688792f',
    ],
  ] as const)(
    'As the resolver reading dotNS storage, I compute the mapping slot of %s as %s',
    (_input, _outcome, key, slotNumber, expected) => {
      // When
      const slot = computeMappingSlot(key, slotNumber);

      // Then
      expect(slot).toBe(expected);
    },
  );
});

describe('computeBytesDataSlot', () => {
  // Pinned from an independent keccak256 of the base slot over @noble/hashes, outside the repo code.
  it('As the resolver reading dotNS storage, I compute where long bytes start as keccak256 of the zero slot', () => {
    // Given
    const slot = '0x0000000000000000000000000000000000000000000000000000000000000000';

    // When
    const dataSlot = computeBytesDataSlot(slot);

    // Then
    expect(dataSlot).toBe('0x290decd9548b62a8d60345a988386fc84ba6bc95484008f6362f93160ef3e563');
  });

  it('As the resolver reading dotNS storage, I compute where long bytes start for another base slot and hash that slot', () => {
    // Given
    const slot = '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';

    // When
    const dataSlot = computeBytesDataSlot(slot);

    // Then
    expect(dataSlot).toBe('0x8f0af42555406ff9bab0485545772d9e31b44053cf31ffbfb75ac5a8554d81fe');
  });
});

describe('addToSlot', () => {
  it.each([
    [
      'a slot by 0',
      'stay on it',
      '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
      0,
      '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
    ],
    [
      'a slot by 1',
      'its last byte goes up by one',
      '0x0000000000000000000000000000000000000000000000000000000000000000',
      1,
      '0x0000000000000000000000000000000000000000000000000000000000000001',
    ],
    [
      'a slot ending in ff by 1',
      'the carry moves into the byte before',
      '0x00000000000000000000000000000000000000000000000000000000000000ff',
      1,
      '0x0000000000000000000000000000000000000000000000000000000000000100',
    ],
    [
      'a slot by 256',
      'land 256 slots on',
      '0x0000000000000000000000000000000000000000000000000000000000000000',
      256,
      '0x0000000000000000000000000000000000000000000000000000000000000100',
    ],
  ] as const)('As the resolver reading dotNS storage, I step %s and %s', (_step, _outcome, slot, offset, expected) => {
    // When
    const stepped = addToSlot(slot, offset);

    // Then
    expect(stepped).toBe(expected);
  });
});

describe('readWordAsBigInt', () => {
  it.each([
    ['an all-zero word', '0', '0x0000000000000000000000000000000000000000000000000000000000000000', 0n],
    ['a word ending in 1', '1', '0x0000000000000000000000000000000000000000000000000000000000000001', 1n],
    [
      'a word with 1 in its second-last byte',
      '256',
      '0x0000000000000000000000000000000000000000000000000000000000000100',
      256n,
    ],
  ] as const)('As the resolver reading dotNS storage, I read %s as %s', (_word, _outcome, word, expected) => {
    // Given
    const data = fromHex(word);

    // When
    const value = readWordAsBigInt(data);

    // Then
    expect(value).toBe(expected);
  });
});

describe('extractAddress', () => {
  it('As the resolver reading dotNS storage, I read the address from the right of a 32-byte word', () => {
    // Given
    const data = new Uint8Array(32);
    const address = [
      0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0x00, 0xaa, 0xbb, 0xcc, 0xdd,
      0xee,
    ];
    data.set(address, 12);

    // When
    const extracted = extractAddress(data);

    // Then
    expect(extracted).toBe('0xaabbccddee11223344556677889900aabbccddee');
  });

  it('As the resolver reading dotNS storage, I read an all-zero word as the zero address', () => {
    // When
    const extracted = extractAddress(new Uint8Array(32));

    // Then
    expect(extracted).toBe('0x0000000000000000000000000000000000000000');
  });
});

describe('decodeBytesSlot', () => {
  const dummySlot = '0x0000000000000000000000000000000000000000000000000000000000000001';

  it('As the resolver reading dotNS storage, I read an all-zero bytes slot as no bytes', () => {
    // When
    const result = decodeBytesSlot(new Uint8Array(32), dummySlot);

    // Then
    expect(result).toBeNull();
  });

  it('As the resolver reading dotNS storage, I read short bytes held inline in their slot', () => {
    // Given
    const data = new Uint8Array(32);
    data[0] = 0xaa;
    data[1] = 0xbb;
    data[2] = 0xcc;
    data[31] = 6; // length * 2

    // When
    const result = decodeBytesSlot(data, dummySlot);

    // Then
    expect(result).toEqual({ inline: true, data: fromHex('0xaabbcc') });
  });

  it('As the resolver reading dotNS storage, I read a long bytes slot as its length and the slot its data starts at', () => {
    // Given
    const data = new Uint8Array(32);
    data[31] = 73; // 36 * 2 + 1

    // When
    const result = decodeBytesSlot(data, dummySlot);

    // Then
    expect(result).toEqual({
      inline: false,
      length: 36,
      // keccak256 of dummySlot, derived independently of the repo code
      dataSlot: '0xb10e2d527612073b26eecdfd717e6a320cf44b4afac2b0732d9fcbe2b7fa0cf6',
    });
  });

  it('As the resolver reading dotNS storage, I read zero-length short bytes as no bytes', () => {
    // Given
    const data = new Uint8Array(32);
    data[31] = 0;

    // When
    const result = decodeBytesSlot(data, dummySlot);

    // Then
    expect(result).toBeNull();
  });
});
