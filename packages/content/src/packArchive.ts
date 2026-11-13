// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ArchiveFiles } from './types.js';

export type PackedArchive = {
  packed: ArrayBuffer;
  index: { p: string; o: number; l: number }[];
};

/** One buffer plus an offset index, so the Service Worker receives one transferable instead of one per file. */
export function packArchive(files: ArchiveFiles): PackedArchive {
  const entries = Object.entries(files);
  const index: PackedArchive['index'] = [];
  let totalSize = 0;
  for (const [, data] of entries) {
    totalSize += data.byteLength;
  }
  const packed = new ArrayBuffer(totalSize);
  const packedView = new Uint8Array(packed);
  let offset = 0;
  for (const [filePath, data] of entries) {
    index.push({ p: filePath, o: offset, l: data.byteLength });
    packedView.set(data, offset);
    offset += data.byteLength;
  }
  return { packed, index };
}
