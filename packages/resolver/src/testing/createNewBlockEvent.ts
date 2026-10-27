// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { FollowEventWithoutRuntime } from '@polkadot-api/substrate-client';

/** A follow's `newBlock` event for `blockHash` on top of `parentBlockHash`. */
export function createNewBlockEvent(blockHash: string, parentBlockHash: string): FollowEventWithoutRuntime {
  return { type: 'newBlock', blockHash, parentBlockHash };
}
