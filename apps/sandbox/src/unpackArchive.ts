// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/// <reference lib="webworker" />

import type { ArchiveIndex } from './archiveDb.js';

/** Each file of the packed archive by its path, as a copy of its bytes. Never throws. */
export function unpackArchive(packed: ArrayBuffer, index: ArchiveIndex): Record<string, ArrayBuffer> {
  const files: Record<string, ArrayBuffer> = {};
  for (const entry of index) {
    files[entry.p] = packed.slice(entry.o, entry.o + entry.l);
  }
  return files;
}
