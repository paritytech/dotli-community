// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { toHex } from '@dotli/shared';
import {
  namehash,
  computeMappingSlot,
  computeBytesDataSlot,
  addToSlot,
  wordToBigInt,
  extractAddress,
  decodeBytesSlot,
  decodeIpfsContenthashResult,
} from './abi.js';

describe('namehash', () => {
  it('As the resolver reading dotNS storage, I hash the empty name to 32 zero bytes', () => {
    // When / Then
    expect(namehash('')).toBe('0x0000000000000000000000000000000000000000000000000000000000000000');
  });

  it('As the resolver reading dotNS storage, I hash eth to the ENS test vector', () => {
    // When / Then
    // Well-known ENS test vector
    expect(namehash('eth')).toBe('0x93cdeb708b7545dc668eb9280176169d1c33cfd8ed6f04690a0bcc88a93fc4ae');
  });

  it('As the resolver reading dotNS storage, I hash foo.eth to the ENS test vector', () => {
    // When / Then
    expect(namehash('foo.eth')).toBe('0xde9b09fd7c5f901e23a3f19fecc54828e9c848539801e86591bd9801b019f84f');
  });
});

describe('computeMappingSlot', () => {
  // Pinned from an independent keccak256(abi.encode(key, slot)) over @noble/hashes, outside the repo code.
  const key1 = '0x0000000000000000000000000000000000000000000000000000000000000001' as `0x${string}`;
  const key2 = '0x0000000000000000000000000000000000000000000000000000000000000002' as `0x${string}`;

  it('As the resolver reading dotNS storage, I compute the mapping slot of a key as keccak256 of the key and the slot', () => {
    // Given
    const key = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef' as `0x${string}`;

    // When / Then
    expect(computeMappingSlot(key, 0)).toBe('0xe99c1dcfc4ac025ecbc3952f42d94d3271d3a0e61c6752073ec8c7a4080f12b8');
  });

  it('As the resolver reading dotNS storage, I compute the mapping slots of two keys and get each one its own slot', () => {
    // When / Then
    expect(computeMappingSlot(key1, 0)).toBe('0xada5013122d395ba3c54772283fb069b10426056ef8ca54750cb9bb552a59e7d');
    expect(computeMappingSlot(key2, 0)).toBe('0xabbb5caa7dda850e60932de0934eb1f9d0f59695050f761dc64e443e5030a569');
  });

  it('As the resolver reading dotNS storage, I compute the mapping slot of one key in the second mapping and the slot number is hashed in', () => {
    // When / Then
    expect(computeMappingSlot(key1, 1)).toBe('0xcc69885fda6bcc1a4ace058b4a62bf5e179ea78fd58a1ccd71c22cc9b688792f');
  });
});

describe('computeBytesDataSlot', () => {
  // Pinned from an independent keccak256 of the base slot over @noble/hashes, outside the repo code.
  it('As the resolver reading dotNS storage, I compute where long bytes start as keccak256 of the zero slot', () => {
    // Given
    const slot = '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`;

    // When / Then
    expect(computeBytesDataSlot(slot)).toBe('0x290decd9548b62a8d60345a988386fc84ba6bc95484008f6362f93160ef3e563');
  });

  it('As the resolver reading dotNS storage, I compute where long bytes start for another base slot and hash that slot', () => {
    // Given
    const slot = '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890' as `0x${string}`;

    // When / Then
    expect(computeBytesDataSlot(slot)).toBe('0x8f0af42555406ff9bab0485545772d9e31b44053cf31ffbfb75ac5a8554d81fe');
  });
});

describe('addToSlot', () => {
  it('As the resolver reading dotNS storage, I step a slot by 0 and stay on it', () => {
    // Given
    const slot = '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890' as `0x${string}`;

    // When / Then
    expect(addToSlot(slot, 0)).toBe(slot);
  });

  it('As the resolver reading dotNS storage, I step a slot by 1 and its last byte goes up by one', () => {
    // Given
    const slot = '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`;

    // When / Then
    expect(addToSlot(slot, 1)).toBe('0x0000000000000000000000000000000000000000000000000000000000000001');
  });

  it('As the resolver reading dotNS storage, I step a slot ending in ff by 1 and the carry moves into the byte before', () => {
    // Given
    const slot = '0x00000000000000000000000000000000000000000000000000000000000000ff' as `0x${string}`;

    // When / Then
    expect(addToSlot(slot, 1)).toBe('0x0000000000000000000000000000000000000000000000000000000000000100');
  });

  it('As the resolver reading dotNS storage, I step a slot by 256 and land 256 slots on', () => {
    // Given
    const slot = '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`;

    // When / Then
    expect(addToSlot(slot, 256)).toBe('0x0000000000000000000000000000000000000000000000000000000000000100');
  });
});

describe('wordToBigInt', () => {
  it('As the resolver reading dotNS storage, I read an all-zero word as 0', () => {
    // When / Then
    expect(wordToBigInt(new Uint8Array(32))).toBe(0n);
  });

  it('As the resolver reading dotNS storage, I read a word ending in 1 as 1', () => {
    // Given
    const data = new Uint8Array(32);
    data[31] = 1;

    // When / Then
    expect(wordToBigInt(data)).toBe(1n);
  });

  it('As the resolver reading dotNS storage, I read a word with 1 in its second-last byte as 256', () => {
    // Given
    const data = new Uint8Array(32);
    data[30] = 1;

    // When / Then
    expect(wordToBigInt(data)).toBe(256n);
  });
});

describe('extractAddress', () => {
  it('As the resolver reading dotNS storage, I read the address from the right of a 32-byte word', () => {
    // Given
    const data = new Uint8Array(32);
    const addr = [
      0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0x00, 0xaa, 0xbb, 0xcc, 0xdd,
      0xee,
    ];
    data.set(addr, 12);

    // When / Then
    expect(extractAddress(data)).toBe('0xaabbccddee11223344556677889900aabbccddee');
  });

  it('As the resolver reading dotNS storage, I read an all-zero word as the zero address', () => {
    // When / Then
    expect(extractAddress(new Uint8Array(32))).toBe('0x0000000000000000000000000000000000000000');
  });
});

describe('decodeBytesSlot', () => {
  const dummySlot = '0x0000000000000000000000000000000000000000000000000000000000000001' as `0x${string}`;

  it('As the resolver reading dotNS storage, I read an all-zero bytes slot as no bytes', () => {
    // When / Then
    expect(decodeBytesSlot(new Uint8Array(32), dummySlot)).toBeNull();
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
    if (result === null) {
      throw new Error('expected a decoded slot');
    }
    expect(result.inline).toBe(true);
    if (result.inline) {
      expect(toHex(result.data)).toBe('0xaabbcc');
    }
  });

  it('As the resolver reading dotNS storage, I read a long bytes slot as its length and the slot its data starts at', () => {
    // Given
    const data = new Uint8Array(32);
    data[31] = 73; // 36 * 2 + 1

    // When
    const result = decodeBytesSlot(data, dummySlot);

    // Then
    if (result === null) {
      throw new Error('expected a decoded slot');
    }
    expect(result.inline).toBe(false);
    if (!result.inline) {
      expect(result.length).toBe(36);
      // keccak256 of dummySlot, derived independently of the repo code
      expect(result.dataSlot).toBe('0xb10e2d527612073b26eecdfd717e6a320cf44b4afac2b0732d9fcbe2b7fa0cf6');
    }
  });

  it('As the resolver reading dotNS storage, I read zero-length short bytes as no bytes', () => {
    // Given
    const data = new Uint8Array(32);
    data[31] = 0;

    // When / Then
    expect(decodeBytesSlot(data, dummySlot)).toBeNull();
  });
});

describe('decodeIpfsContenthashResult', () => {
  it('As the resolver reading dotNS storage, I read an empty contenthash as no record', () => {
    // When / Then
    expect(decodeIpfsContenthashResult('')).toEqual({ kind: 'empty' });
    expect(decodeIpfsContenthashResult('0x')).toEqual({ kind: 'empty' });
    expect(decodeIpfsContenthashResult('0x0')).toEqual({ kind: 'empty' });
  });

  it('As the resolver reading dotNS storage, I read a too-short contenthash as no record', () => {
    // When / Then
    expect(decodeIpfsContenthashResult('0xab')).toEqual({ kind: 'empty' });
  });

  it('As the resolver reading dotNS storage, I read a contenthash of another codec as unsupported', () => {
    // When / Then
    // Swarm codec prefix
    expect(decodeIpfsContenthashResult('0xe40101')).toMatchObject({ kind: 'unsupported-codec' });
  });

  it('As the resolver reading dotNS storage, I read an IPFS CIDv1 contenthash as its CID', () => {
    // Given
    // Real ENS-encoded IPFS CIDv1: encode('ipfs', 'bafybeibj6lixxzqtsb45ysdjnupvqkufgdvzqbnvmhw2kf7cfkesy7r7d4')
    const validIpfsContenthash = 'e3010170122029f2d17be6139079dc48696d1f582a8530eb9805b561eda517e22a892c7e3f1f';

    // When / Then
    expect(decodeIpfsContenthashResult(validIpfsContenthash)).toEqual({
      kind: 'ok',
      cid: 'bafybeibj6lixxzqtsb45ysdjnupvqkufgdvzqbnvmhw2kf7cfkesy7r7d4',
    });
  });

  it('As the resolver reading dotNS storage, I read a contenthash the same with or without its 0x prefix', () => {
    // Given
    const hex = '0xe3010170122029f2d17be6139079dc48696d1f582a8530eb9805b561eda517e22a892c7e3f1f';
    const hexWithout = 'e3010170122029f2d17be6139079dc48696d1f582a8530eb9805b561eda517e22a892c7e3f1f';

    // When / Then
    expect(decodeIpfsContenthashResult(hex)).toEqual(decodeIpfsContenthashResult(hexWithout));
  });
});
