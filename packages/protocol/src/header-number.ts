// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

function littleEndian(bytes: readonly number[]): number {
  return bytes.reduce((sum, byte, index) => sum + byte * 2 ** (8 * index), 0);
}

/**
 * The block number of a SCALE-encoded header, which opens with the 32-byte parent hash and then the number as a
 * compact integer. Null when the bytes are not a header.
 */
export function decodeHeaderNumber(header: string): number | null {
  const hex = header.startsWith('0x') ? header.slice(2) : header;
  const bytes = (count: number): number[] | null => {
    const out: number[] = [];
    for (let index = 0; index < count; index += 1) {
      const pair = hex.slice(64 + index * 2, 66 + index * 2);
      if (!/^[0-9a-fA-F]{2}$/.test(pair)) {
        return null;
      }
      out.push(Number.parseInt(pair, 16));
    }
    return out;
  };
  const lead = bytes(1)?.[0];
  if (lead === undefined) {
    return null;
  }
  const mode = lead & 0b11;
  if (mode === 0b11) {
    // Big-integer mode. A u32 block number takes exactly four bytes after the mode byte.
    if (lead >>> 2 !== 0) {
      return null;
    }
    const raw = bytes(5);
    return raw === null ? null : littleEndian(raw.slice(1));
  }
  const raw = bytes(mode === 0 ? 1 : mode === 1 ? 2 : 4);
  return raw === null ? null : Math.floor(littleEndian(raw) / 4);
}
