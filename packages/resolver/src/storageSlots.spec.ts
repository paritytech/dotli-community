// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { fromHex } from '@dotli/shared';
import { computeNamehash, computeMappingSlot, addToSlot, readWordAsBigInt, decodeBytesSlot } from './storageSlots.js';

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

  // Pinned from an independent keccak256(key ++ baseSlot), and read live as the Registrar's holder of browse.paseo.
  it('As the resolver reading dotNS storage, I compute the mapping slot of a key under a 32-byte base slot as keccak256 of the key and that slot', () => {
    // Given a 32-byte name id and a 32-byte base slot
    const nameId = '0x1850561ffded63ac23dac8fd5e793fca1f349729ed6ade91c45f44a9f7b6b781';
    const baseSlot = '0x80bb2b638cc20bc4d0a60d66940f3ab4a00c1d7b313497ca82fb0b4ab0079302';

    // When the mapping slot is computed
    const slot = computeMappingSlot(nameId, baseSlot);

    // Then the slot matches the pinned keccak256 value
    expect(slot).toBe('0x4d1417a373d6fab66ca8f84f8d0eb0be405b448ffefd17d78d8d6df67f8653c5');
  });

  it('As the resolver reading dotNS storage, I refuse a hex base slot that is not 32 bytes and the error names it', () => {
    // Given a base slot of one byte
    const nameId = '0x1850561ffded63ac23dac8fd5e793fca1f349729ed6ade91c45f44a9f7b6b781';
    const baseSlot = '0x00';

    // When the mapping slot is computed
    const compute = () => computeMappingSlot(nameId, baseSlot);

    // Then the computation throws and names the base slot
    expect(compute).toThrow('0x00');
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
});
