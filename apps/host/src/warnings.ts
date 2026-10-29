// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A warning is not an error: the load is still running and may finish, so each line says what is happening.

import type { ChainRole } from '@dotli/config';
import { formatRate } from '@dotli/shared';
import { STILL_WORKING } from './stillWorking.js';

export type CriticalChain = (typeof CRITICAL_CHAINS)[number];

export type StallFacts = {
  chain: CriticalChain;
  /** Null until a sample comes back. */
  peers: number | null;
  /** Across every network the shell can see. */
  bytesPerSecond: number | null;
  /** The word smoldot itself uses for why it stalled, on `stalled` only. */
  reason?: string | undefined;
};

/** The chains the load waits on. A stall elsewhere is not the visitor's problem. */
export const CRITICAL_CHAINS = ['relay', 'assethub', 'bulletin'] as const satisfies readonly ChainRole[];

const CHAIN_WORDS: Record<CriticalChain, string> = {
  relay: 'Polkadot',
  assethub: 'the name registry',
  bulletin: 'the app files',
};

/**
 * At or above this the connection is not what holds the load, so no warning names it. Healthy cold loads average
 * about 2 MB/s.
 */
export const SLOW_BYTES_PER_SECOND = 128 * 1024;

/** Returns whether the load waits on `chain`. Never throws. */
export function isCriticalChain(chain: ChainRole): chain is CriticalChain {
  return CRITICAL_CHAINS.some(critical => critical === chain);
}

/**
 * Null when nothing is wrong, the common case: healthy chains dwell in `connecting` for seconds. Only no peers, a
 * stall smoldot reports, or a peered chain with little or no data earns a warning. A missing peer sample is not one.
 * Never throws.
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
  if (isFast(facts.bytesPerSecond)) {
    return null;
  }
  const rate = formatThroughput(facts.bytesPerSecond);
  if (rate === null) {
    return `Connected to ${peerWords} for ${what}, but no data is arriving yet.`;
  }
  return `Fetching ${what} from ${peerWords} at ${rate}. Slower than usual.`;
}

/**
 * For a parked bar, which the per-chain watchdog misses when a chain never reaches a peer and so emits nothing. No
 * percentage, since one baked into a sentence goes stale as the bar moves. With nothing arriving it names no cause:
 * the bar also parks while the light client starts or verifies, and a lost connection is the topbar's to announce.
 * Never throws.
 */
export function describeProgressStall(bytesPerSecond: number | null): string | null {
  if (isFast(bytesPerSecond)) {
    return null;
  }
  const rate = formatThroughput(bytesPerSecond);
  if (rate !== null) {
    return `Still downloading at ${rate}. That is slower than this app usually needs, so give it a moment.`;
  }
  return STILL_WORKING;
}

function isFast(bytesPerSecond: number | null): boolean {
  return bytesPerSecond !== null && bytesPerSecond >= SLOW_BYTES_PER_SECOND;
}

function formatThroughput(bytesPerSecond: number | null): string | null {
  // The "connected but nothing arriving" sentence covers under a byte a second.
  if (bytesPerSecond === null || bytesPerSecond < 1) {
    return null;
  }
  return formatRate(bytesPerSecond);
}
