// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** A SCALE header: a zero parent hash, the number as a compact, then bytes the decoder never reads. */
export function headerHex(blockNumber: number): string {
  let compact: number[];
  if (blockNumber < 2 ** 6) {
    compact = [blockNumber * 4];
  } else if (blockNumber < 2 ** 14) {
    const value = blockNumber * 4 + 1;
    compact = [value % 256, Math.floor(value / 256)];
  } else if (blockNumber < 2 ** 30) {
    const value = blockNumber * 4 + 2;
    compact = [0, 1, 2, 3].map(i => Math.floor(value / 256 ** i) % 256);
  } else {
    compact = [0b11, ...[0, 1, 2, 3].map(i => Math.floor(blockNumber / 256 ** i) % 256)];
  }
  const hex = compact.map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `0x${'00'.repeat(32)}${hex}${'00'.repeat(64)}`;
}
