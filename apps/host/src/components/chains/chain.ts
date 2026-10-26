// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** A block's arrival against the chain's block time, which colours its bar. */
export type BarHealth = 'onTime' | 'late' | 'veryLate';

export type ChainBar = {
  readonly number: number;
  readonly health: BarHealth;
  /** Since the previous block arrived. */
  readonly gapMs: number;
};

/** How a chain counts toward the network's verdict. */
export type ChainUse = 'unused' | 'pending' | 'live';

/** One chain as its group shows it: its name, use, peers and recent blocks. */
export type ChainSummary = {
  readonly label: string;
  readonly state: ChainUse;
  readonly blockTimeMs: number;
  /** Oldest first. A bar already drawn keeps its object across updates, so the same bars mean no block landed. */
  readonly bars: readonly ChainBar[];
  /** False when the active network offers no endpoint for this chain. */
  readonly reachable: boolean;
  /** What a chain with no bar yet waits on, in words. */
  readonly phase: string | null;
  /** Null where the backend never reports peers. */
  readonly peers: number | null;
};
