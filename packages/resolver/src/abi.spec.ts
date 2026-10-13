// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
  namehash,
  toHex,
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

  it('As the resolver reading dotNS storage, I hash the dot TLD to a nonzero 32-byte hash', () => {
    // When
    const hash = namehash('dot');

    // Then
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(hash).not.toBe('0x0000000000000000000000000000000000000000000000000000000000000000');
  });

  it("As the resolver reading dotNS storage, I hash myapp.dot to a 32-byte hash other than its TLD's", () => {
    // When
    const hash = namehash('myapp.dot');

    // Then
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(hash).not.toBe(namehash('dot'));
  });

  it('As the resolver reading dotNS storage, I hash two labels and get two hashes', () => {
    // When / Then
    expect(namehash('a.dot')).not.toBe(namehash('b.dot'));
  });

  it('As the resolver reading dotNS storage, I hash the same name twice and get the same hash', () => {
    // When / Then
    expect(namehash('test.dot')).toBe(namehash('test.dot'));
  });
});

describe('computeMappingSlot', () => {
  it('As the resolver reading dotNS storage, I compute a mapping slot as a 32-byte hex key', () => {
    // Given
    const key = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef' as `0x${string}`;

    // When
    const result = computeMappingSlot(key, 0);

    // Then
    expect(result).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('As the resolver reading dotNS storage, I compute the mapping slots of two keys and get two slots', () => {
    // Given
    const key1 = namehash('a.dot');
    const key2 = namehash('b.dot');

    // When / Then
    expect(computeMappingSlot(key1, 0)).not.toBe(computeMappingSlot(key2, 0));
  });

  it('As the resolver reading dotNS storage, I compute the mapping slots of one key in two mappings and get two slots', () => {
    // Given
    const key = namehash('test.dot');

    // When / Then
    expect(computeMappingSlot(key, 0)).not.toBe(computeMappingSlot(key, 1));
  });

  it('As the resolver reading dotNS storage, I compute the same mapping slot twice and get the same slot', () => {
    // Given
    const key = namehash('test.dot');

    // When / Then
    expect(computeMappingSlot(key, 0)).toBe(computeMappingSlot(key, 0));
  });
});

describe('computeBytesDataSlot', () => {
  it('As the resolver reading dotNS storage, I compute where long bytes start as a 32-byte hex key', () => {
    // Given
    const slot = '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890' as `0x${string}`;

    // When
    const result = computeBytesDataSlot(slot);

    // Then
    expect(result).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('As the resolver reading dotNS storage, I compute where long bytes start and get a slot other than the one holding their length', () => {
    // Given
    const slot = '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`;

    // When
    const result = computeBytesDataSlot(slot);

    // Then
    expect(result).not.toBe(slot);
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
      expect(result.dataSlot).toMatch(/^0x[0-9a-f]{64}$/);
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
