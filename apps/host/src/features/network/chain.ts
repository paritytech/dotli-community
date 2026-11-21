// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ChainPhase } from './networkMonitorState.js';

/** A block's arrival against the chain's block time, which colours its bar. */
export type BarHealth = 'onTime' | 'late' | 'veryLate';

export type ChainBar = {
  readonly number: number;
  readonly health: BarHealth;
  /** Since the previous block arrived. */
  readonly gapMs: number;
};

/** How a chain counts toward the network's verdict. `down` while its pool reports it disconnected. */
export type ChainUse = 'unused' | 'pending' | 'down' | 'live';

/** Whether a chain has an endpoint and is in use, so its reads age between blocks. */
export function isWatched(chain: Pick<ChainSummary, 'reachable' | 'state'>): boolean {
  return chain.reachable && chain.state !== 'unused';
}

/** One chain as its row shows it: its name, use, peers and recent blocks. */
export type ChainSummary = {
  readonly label: string;
  readonly state: ChainUse;
  readonly blockTimeMs: number;
  /** Oldest first. A bar already drawn keeps its object across updates, so the same bars mean no block landed. */
  readonly bars: readonly ChainBar[];
  /** False when the active network offers no endpoint for this chain. */
  readonly reachable: boolean;
  /** The light client's phase as the chain comes up, null for a chain it does not report. */
  readonly phase: ChainPhase | null;
  /** The share of its last warp the light client proved, from 0 to 1. Null before any. */
  readonly syncShare: number | null;
  /** Null where the backend never reports peers. */
  readonly peers: number | null;
};
