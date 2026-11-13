// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ChainSummary } from './chain.js';

/** Slots in a chain's history strip, filled from the right as samples arrive. */
export const HISTORY_SLOTS = 48;

/**
 * How a block's arrival reads on hover.
 * A block inside the expectation says "on time", since "0s late" suggests a problem.
 */
export function describeBlockDelay(gapMs: number, blockTimeMs: number): string {
  const secs = (ms: number): string =>
    ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${String(Math.round(ms / 1000))}s`;
  const late = gapMs - blockTimeMs;
  return late <= 0 ? `${secs(gapMs)}, on time` : `${secs(gapMs)}, ${secs(late)} late`;
}

/**
 * The ghost bar before a chain's first bar: what it waits on and what it says. Once a block has landed it also has a
 * height, in percent.
 */
export type PendingBarView =
  { phase: 'searching'; text: string } | { phase: 'counting' | 'due'; heightPercent: number; text: string };

/**
 * The ghost bar and estimate `sinceLast` ms after the chain's last block, null before any.
 * The copy never shows zero or a negative: past the estimate it swaps to words.
 */
export function pendingBar(
  chain: Pick<ChainSummary, 'blockTimeMs' | 'phase'>,
  sinceLast: number | null,
): PendingBarView {
  if (sinceLast === null) {
    return { phase: 'searching', text: chain.phase ?? 'connecting' };
  }
  const heightPercent = Math.round(20 + Math.min(sinceLast / chain.blockTimeMs, 1) * 80);
  const leftMs = chain.blockTimeMs - sinceLast;
  return leftMs > 0
    ? { phase: 'counting', heightPercent, text: `next block in about ${String(Math.ceil(leftMs / 1000))}s` }
    : { phase: 'due', heightPercent, text: 'due any moment' };
}

/**
 * How many bars of `shown` are newer than the newest of `before`, so a re-render with the same history slides nothing.
 * Bars landing in a strip that showed none appear without sliding, so they count as none.
 */
export function landedBars(before: readonly { number: number }[], shown: readonly { number: number }[]): number {
  const newest = before.at(-1)?.number;
  const landed = newest === undefined ? shown.length : shown.filter(bar => bar.number > newest).length;
  return landed > 0 && shown.length > landed ? landed : 0;
}

/** A chain's peers chip: what it says, its tone, which warns at zero peers, and its name, which names the chain. */
export function describePeers(chain: string, peers: number): { text: string; tone: 'warn' | 'mono'; label: string } {
  const text = peers === 1 ? '1 peer' : `${String(peers)} peers`;
  return { text, tone: peers === 0 ? 'warn' : 'mono', label: `${chain}: ${text} connected` };
}

/** Older slots fade, to half strength at the left edge. */
export function slotOpacity(slot: number): string {
  return (0.5 + (0.5 * slot) / (HISTORY_SLOTS - 1)).toFixed(2);
}

/** Whether two bar lists hold the same bar objects, so an update that landed no block changes nothing. */
export function sameBars(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((bar, i) => bar === b[i]);
}
