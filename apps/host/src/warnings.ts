// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What to tell a visitor when a chain stops making progress.
//
// A warning is not an error. The load is still running and may well finish,
// so every line here says what is happening and, where it can, why. The copy
// lives beside `errors.ts` because both are the host's user-facing words.

import type { ChainKey, ChainSyncKind } from "@dotli/resolver/smoldot";

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
  /** The lifecycle state it is stuck in. */
  state: ChainSyncKind;
  /** Live peer count, or null when no sample has come back yet. */
  peers: number | null;
  /** Bytes per second across every network the shell can see, or null. */
  bytesPerSecond: number | null;
  /** Smoldot's own word for why it stalled, on `stalled` only. */
  reason?: string;
}

const CHAIN_WORDS: Record<CriticalChain, string> = {
  relay: "Polkadot",
  "asset-hub": "the name registry",
  bulletin: "the app's files",
};

function throughput(bytesPerSecond: number | null): string | null {
  if (bytesPerSecond === null || bytesPerSecond <= 0) {
    return null;
  }
  return bytesPerSecond < 1_048_576
    ? `${String(Math.round(bytesPerSecond / 1024))} kB/s`
    : `${(bytesPerSecond / 1_048_576).toFixed(1)} MB/s`;
}

/**
 * One sentence explaining a stalled chain, built from what is measurable.
 *
 * Ordered by how actionable the cause is. No peers is the only condition the
 * visitor can do anything about, by waiting or moving network, so it is
 * checked first. A healthy peer count with data flowing means the chain is
 * simply slow, which is worth saying plainly rather than alarming about.
 */
export function describeStall(facts: StallFacts): string {
  const what = CHAIN_WORDS[facts.chain];
  const rate = throughput(facts.bytesPerSecond);

  if (facts.reason === "noPeers" || facts.peers === 0) {
    return `Still looking for computers that carry ${what}. Nothing has answered yet.`;
  }
  if (facts.peers === null) {
    return `Waiting to hear back from the network about ${what}.`;
  }
  const peerWords =
    facts.peers === 1 ? "1 computer" : `${String(facts.peers)} computers`;
  if (facts.reason !== undefined) {
    return `${what} stopped advancing with ${peerWords} connected. Retrying.`;
  }
  if (rate === null) {
    return `Connected to ${peerWords} for ${what}, but no data is arriving yet.`;
  }
  return `Fetching ${what} from ${peerWords} at ${rate}. Slower than usual.`;
}
