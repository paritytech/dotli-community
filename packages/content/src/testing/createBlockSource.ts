// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { BlockSource } from '../types.js';

/** A block source over a block map by CID string that answers at once, and rejects a CID the map lacks. */
export function createBlockSource(blocks: Map<string, Uint8Array>): BlockSource {
  return cid => {
    const bytes = blocks.get(cid.toString());
    return bytes === undefined ? Promise.reject(new Error(`not found: ${cid.toString()}`)) : Promise.resolve(bytes);
  };
}
