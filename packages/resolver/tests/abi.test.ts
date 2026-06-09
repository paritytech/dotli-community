// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from "vitest";
import {
  namehash,
  toHex,
  computeMappingSlot,
  computeBytesDataSlot,
  addToSlot,
  wordToBigInt,
  extractAddress,
  decodeBytesSlot,
  decodeIpfsContenthash,
} from "@dotli/resolver/abi";

describe("namehash", () => {
  it("returns 32 zero bytes for empty string", () => {
    expect(namehash("")).toBe(
      "0x0000000000000000000000000000000000000000000000000000000000000000",
    );
  });

  it("computes correct hash for 'eth'", () => {
    // Well-known ENS test vector
    expect(namehash("eth")).toBe(
      "0x93cdeb708b7545dc668eb9280176169d1c33cfd8ed6f04690a0bcc88a93fc4ae",
    );
  });

  it("computes correct hash for 'foo.eth'", () => {
    expect(namehash("foo.eth")).toBe(
      "0xde9b09fd7c5f901e23a3f19fecc54828e9c848539801e86591bd9801b019f84f",
    );
  });

  it("computes hash for .dot TLD", () => {
    const hash = namehash("dot");
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(hash).not.toBe(
      "0x0000000000000000000000000000000000000000000000000000000000000000",
    );
  });

  it("computes hash for myapp.dot", () => {
    const hash = namehash("myapp.dot");
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
    // Must differ from just "dot"
    expect(hash).not.toBe(namehash("dot"));
  });

  it("produces different hashes for different labels", () => {
    expect(namehash("a.dot")).not.toBe(namehash("b.dot"));
  });

  it("is deterministic", () => {
    expect(namehash("test.dot")).toBe(namehash("test.dot"));
  });
});

describe("computeMappingSlot", () => {
  it("returns a 32-byte hex key", () => {
    const key =
      "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef" as `0x${string}`;
    const result = computeMappingSlot(key, 0);
    expect(result).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("produces different slots for different keys", () => {
    const key1 = namehash("a.dot");
    const key2 = namehash("b.dot");
    expect(computeMappingSlot(key1, 0)).not.toBe(computeMappingSlot(key2, 0));
  });

  it("produces different slots for different slot numbers", () => {
    const key = namehash("test.dot");
    expect(computeMappingSlot(key, 0)).not.toBe(computeMappingSlot(key, 1));
  });

  it("is deterministic", () => {
    const key = namehash("test.dot");
    expect(computeMappingSlot(key, 0)).toBe(computeMappingSlot(key, 0));
  });
});

describe("computeBytesDataSlot", () => {
  it("returns a 32-byte hex key", () => {
    const slot =
      "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890" as `0x${string}`;
    const result = computeBytesDataSlot(slot);
    expect(result).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("produces a different slot from the input", () => {
    const slot =
      "0x0000000000000000000000000000000000000000000000000000000000000000" as `0x${string}`;
    const result = computeBytesDataSlot(slot);
    expect(result).not.toBe(slot);
  });
});

describe("addToSlot", () => {
  it("returns same slot for offset 0", () => {
    const slot =
      "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890" as `0x${string}`;
    expect(addToSlot(slot, 0)).toBe(slot);
  });

  it("increments the last byte for offset 1", () => {
    const slot =
      "0x0000000000000000000000000000000000000000000000000000000000000000" as `0x${string}`;
    expect(addToSlot(slot, 1)).toBe(
      "0x0000000000000000000000000000000000000000000000000000000000000001",
    );
  });

  it("handles carry across bytes", () => {
    const slot =
      "0x00000000000000000000000000000000000000000000000000000000000000ff" as `0x${string}`;
    expect(addToSlot(slot, 1)).toBe(
      "0x0000000000000000000000000000000000000000000000000000000000000100",
    );
  });

  it("handles multi-byte offset", () => {
    const slot =
      "0x0000000000000000000000000000000000000000000000000000000000000000" as `0x${string}`;
    expect(addToSlot(slot, 256)).toBe(
      "0x0000000000000000000000000000000000000000000000000000000000000100",
    );
  });
});

describe("wordToBigInt", () => {
  it("decodes zero", () => {
    expect(wordToBigInt(new Uint8Array(32))).toBe(0n);
  });

  it("decodes 1", () => {
    const data = new Uint8Array(32);
    data[31] = 1;
    expect(wordToBigInt(data)).toBe(1n);
  });

  it("decodes 256", () => {
    const data = new Uint8Array(32);
    data[30] = 1;
    expect(wordToBigInt(data)).toBe(256n);
  });
});

describe("extractAddress", () => {
  it("extracts address from right-aligned 32-byte word", () => {
    const data = new Uint8Array(32);
    // Set last 20 bytes to a known address
    const addr = [
      0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77,
      0x88, 0x99, 0x00, 0xaa, 0xbb, 0xcc, 0xdd, 0xee,
    ];
    data.set(addr, 12);
    expect(extractAddress(data)).toBe(
      "0xaabbccddee11223344556677889900aabbccddee",
    );
  });

  it("returns zero address for all-zero word", () => {
    expect(extractAddress(new Uint8Array(32))).toBe(
      "0x0000000000000000000000000000000000000000",
    );
  });
});

describe("decodeBytesSlot", () => {
  const dummySlot =
    "0x0000000000000000000000000000000000000000000000000000000000000001" as `0x${string}`;

  it("returns null for all-zero slot", () => {
    expect(decodeBytesSlot(new Uint8Array(32), dummySlot)).toBeNull();
  });

  it("decodes short bytes (inline)", () => {
    // 3 bytes of data: 0xaabbcc, length = 3, lowest byte = 6 (3*2)
    const data = new Uint8Array(32);
    data[0] = 0xaa;
    data[1] = 0xbb;
    data[2] = 0xcc;
    data[31] = 6; // length * 2
    const result = decodeBytesSlot(data, dummySlot);
    expect(result).not.toBeNull();
    expect(result!.inline).toBe(true);
    if (result!.inline) {
      expect(toHex(result!.data)).toBe("0xaabbcc");
    }
  });

  it("detects long bytes", () => {
    // Long bytes: lowest bit is 1, word = length * 2 + 1
    // For 36 bytes: 36 * 2 + 1 = 73 = 0x49
    const data = new Uint8Array(32);
    data[31] = 73; // 0x49
    const result = decodeBytesSlot(data, dummySlot);
    expect(result).not.toBeNull();
    expect(result!.inline).toBe(false);
    if (!result!.inline) {
      expect(result!.length).toBe(36);
      expect(result!.dataSlot).toMatch(/^0x[0-9a-f]{64}$/);
    }
  });

  it("returns null for zero-length short bytes", () => {
    const data = new Uint8Array(32);
    data[31] = 0; // length * 2 = 0
    expect(decodeBytesSlot(data, dummySlot)).toBeNull();
  });
});

describe("decodeIpfsContenthash", () => {
  it("returns null for empty hex", () => {
    expect(decodeIpfsContenthash("")).toBeNull();
    expect(decodeIpfsContenthash("0x")).toBeNull();
    expect(decodeIpfsContenthash("0x0")).toBeNull();
  });

  it("returns null for too-short hex", () => {
    expect(decodeIpfsContenthash("0xab")).toBeNull();
  });

  it("returns null for non-IPFS codec", () => {
    // Swarm codec prefix
    expect(decodeIpfsContenthash("0xe40101")).toBeNull();
  });

  it("decodes valid IPFS CIDv1 contenthash", () => {
    // Real ENS-encoded IPFS CIDv1: encode('ipfs', 'bafybeibj6lixxzqtsb45ysdjnupvqkufgdvzqbnvmhw2kf7cfkesy7r7d4')
    const validIpfsContenthash =
      "e3010170122029f2d17be6139079dc48696d1f582a8530eb9805b561eda517e22a892c7e3f1f";
    const result = decodeIpfsContenthash(validIpfsContenthash);
    expect(result).not.toBeNull();
    expect(result).toBe(
      "bafybeibj6lixxzqtsb45ysdjnupvqkufgdvzqbnvmhw2kf7cfkesy7r7d4",
    );
  });

  it("handles 0x prefix", () => {
    const hex =
      "0xe3010170122029f2d17be6139079dc48696d1f582a8530eb9805b561eda517e22a892c7e3f1f";
    const hexWithout =
      "e3010170122029f2d17be6139079dc48696d1f582a8530eb9805b561eda517e22a892c7e3f1f";
    expect(decodeIpfsContenthash(hex)).toBe(decodeIpfsContenthash(hexWithout));
  });
});
