// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A warning is not an error: the load is still running and may finish, so each line says what is happening.

import type { ChainKey } from '@dotli/resolver';

/** How long a chain may sit in one lifecycle state before it owes an explanation. */
export const STALL_WARNING_MS = 3_000;

/** The chains the load waits on. A stall elsewhere is not the visitor's problem. */
export const CRITICAL_CHAINS = ['relay', 'asset-hub', 'bulletin'] as const satisfies readonly ChainKey[];

export type CriticalChain = (typeof CRITICAL_CHAINS)[number];

export function isCriticalChain(chain: ChainKey): chain is CriticalChain {
  return (CRITICAL_CHAINS as readonly ChainKey[]).includes(chain);
}

export interface StallFacts {
  chain: CriticalChain;
  /** Null until a sample comes back. */
  peers: number | null;
  /** Across every network the shell can see. */
  bytesPerSecond: number | null;
  /** The word smoldot itself uses for why it stalled, on `stalled` only. */
  reason?: string | undefined;
}

const CHAIN_WORDS: Record<CriticalChain, string> = {
  relay: 'Polkadot',
  'asset-hub': 'the name registry',
  bulletin: 'the app files',
};

function throughput(bytesPerSecond: number | null): string | null {
  // The "connected but nothing arriving" sentence covers under a byte a second.
  if (bytesPerSecond === null || bytesPerSecond < 1) {
    return null;
  }
  // Bytes, not kB, so a trickle never rounds to "0 kB/s".
  if (bytesPerSecond < 1024) {
    return `${String(Math.round(bytesPerSecond))} B/s`;
  }
  return bytesPerSecond < 1_048_576
    ? `${String(Math.round(bytesPerSecond / 1024))} kB/s`
    : `${(bytesPerSecond / 1_048_576).toFixed(1)} MB/s`;
}

/**
 * Null when nothing is wrong, the common case: healthy chains dwell in `connecting` for seconds. Only no peers, a
 * stall smoldot reports, or a peered chain with no data earns a warning. A missing peer sample is not one.
 */
export function describeStall(facts: StallFacts): string | null {
  const what = CHAIN_WORDS[facts.chain];

  if (facts.reason === 'noPeers' || facts.peers === 0) {
    return `Still looking for computers that carry ${what}. Nothing has answered yet.`;
  }
  if (facts.peers === null) {
    return null;
  }
  const peerWords = facts.peers === 1 ? '1 computer' : `${String(facts.peers)} computers`;
  if (facts.reason !== undefined) {
    return `${what} stopped advancing with ${peerWords} connected. Retrying.`;
  }
  const rate = throughput(facts.bytesPerSecond);
  if (rate === null) {
    return `Connected to ${peerWords} for ${what}, but no data is arriving yet.`;
  }
  return `Fetching ${what} from ${peerWords} at ${rate}. Slower than usual.`;
}

/**
 * Early warnings read as failure on loads that would succeed. A condition that fires earlier is shown at this mark if
 * it still stands.
 */
export const WARNING_MIN_LOAD_MS = 5_000;

/**
 * For a parked bar, which the per-chain watchdog misses when a chain never reaches a peer and so emits nothing. No
 * percentage, since one baked into a sentence goes stale as the bar moves.
 */
export function describeProgressStall(bytesPerSecond: number | null): string {
  const rate = throughput(bytesPerSecond);
  if (rate !== null) {
    return `Still downloading at ${rate}. That is slower than this app usually needs, so give it a moment.`;
  }
  return 'Still working. No data is arriving right now, so it may be your connection.';
}
