// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { BitswapBlockSource } from '../types.js';

/** A block source over a block map by CID string that answers at once, and rejects a CID the map lacks. */
export function createBitswapBlockSource(blocks: Map<string, Uint8Array>): BitswapBlockSource {
  return cid => {
    const bytes = blocks.get(cid);
    return bytes === undefined ? Promise.reject(new Error(`not found: ${cid}`)) : Promise.resolve(bytes);
  };
}
