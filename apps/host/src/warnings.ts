// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What to tell a visitor when a chain stops making progress.
//
// A warning is not an error. The load is still running and may well finish,
// so every line here says what is happening and, where it can, why. The copy
// lives beside `errors.ts` because both carry the user-facing copy of the host.

import type { ChainKey } from "@dotli/resolver/chain-sync";

/**
 * How long a chain may sit in one lifecycle state before it owes an
 * explanation.
 */
export const STALL_WARNING_MS = 3_000;

/** Chains the load actually waits on. A stall elsewhere is not the visitor's problem. */
export const CRITICAL_CHAINS = [
  "relay",
  "asset-hub",
  "bulletin",
] as const satisfies readonly ChainKey[];

export type CriticalChain = (typeof CRITICAL_CHAINS)[number];

export function isCriticalChain(chain: ChainKey): chain is CriticalChain {
  return (CRITICAL_CHAINS as readonly ChainKey[]).includes(chain);
}

/** Everything known about a chain that has stopped moving. */
export interface StallFacts {
  chain: CriticalChain;
  /** Live peer count, or null when no sample has come back yet. */
  peers: number | null;
  /** Bytes per second across every network the shell can see, or null. */
  bytesPerSecond: number | null;
  /** The word smoldot itself uses for why it stalled, on `stalled` only. */
  reason?: string;
}

const CHAIN_WORDS: Record<CriticalChain, string> = {
  relay: "Polkadot",
  "asset-hub": "the name registry",
  bulletin: "the app files",
};

function throughput(bytesPerSecond: number | null): string | null {
  // Under a byte a second there is no honest number to print, and the sentence
  // for "connected but nothing arriving" already covers it.
  if (bytesPerSecond === null || bytesPerSecond < 1) {
    return null;
  }
  // Below half a kilobyte the kB rounding reads "0 kB/s", which says the
  // opposite of what is happening: bytes are moving, just barely.
  if (bytesPerSecond < 1024) {
    return `${String(Math.round(bytesPerSecond))} B/s`;
  }
  return bytesPerSecond < 1_048_576
    ? `${String(Math.round(bytesPerSecond / 1024))} kB/s`
    : `${(bytesPerSecond / 1_048_576).toFixed(1)} MB/s`;
}

/**
 * One sentence explaining a stalled chain, or null when there is nothing
 * worth saying.
 *
 * Null is the common case and it matters. Sitting in one state for a few
 * seconds is normal: measured on a healthy load, chains dwell in `connecting`
 * for 3s, 8s and 11s, so a dwell alone is not evidence of trouble. A warning
 * is earned only by a fact that says something is actually wrong, which means
 * no peers, smoldot reporting a stall of its own, or a peered chain with no
 * data moving. Absence of a peer sample is absence of information, not a
 * problem, and warning about it fired on every single load.
 */
export function describeStall(facts: StallFacts): string | null {
  const what = CHAIN_WORDS[facts.chain];

  if (facts.reason === "noPeers" || facts.peers === 0) {
    return `Still looking for computers that carry ${what}. Nothing has answered yet.`;
  }
  if (facts.peers === null) {
    return null;
  }
  const peerWords =
    facts.peers === 1 ? "1 computer" : `${String(facts.peers)} computers`;
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
 * How long a load must have been running before any warning may appear.
 *
 * Warnings that arrive in the first seconds read as failure on loads that were
 * always going to succeed, and a warning that flashes in and out is worse than
 * none. A condition that fires earlier is held back and shown at this mark if
 * it still stands.
 */
export const WARNING_MIN_LOAD_MS = 5_000;

/**
 * One sentence for a bar that has stopped moving.
 *
 * The per-chain watchdog cannot cover this: a chain that never reaches a peer
 * emits nothing, so its lifecycle stays quiet while the bar parks. The message
 * carries no percentage, because the bar above already shows the live one and
 * a number baked into a sentence goes stale the moment the bar moves.
 */
export function describeProgressStall(bytesPerSecond: number | null): string {
  const rate = throughput(bytesPerSecond);
  if (rate !== null) {
    return `Still downloading at ${rate}. That is slower than this app usually needs, so give it a moment.`;
  }
  return "Still working. No data is arriving right now, so it may be your connection.";
}
