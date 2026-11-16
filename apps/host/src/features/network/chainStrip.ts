// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ChainBar, ChainSummary } from './chain.js';

/** Slots in a chain's history strip, filled from the right as samples arrive. */
export const HISTORY_SLOTS = 48;

/** Seconds with one decimal under ten, whole above. */
function formatSeconds(ms: number): string {
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${String(Math.round(ms / 1000))}s`;
}

/**
 * How a block's arrival reads on hover.
 * A block inside the expectation says "on time", since "0s late" suggests a problem.
 */
export function describeBlockDelay(gapMs: number, blockTimeMs: number): string {
  const late = gapMs - blockTimeMs;
  return late <= 0 ? `${formatSeconds(gapMs)}, on time` : `${formatSeconds(gapMs)}, ${formatSeconds(late)} late`;
}

/**
 * The caption of a chain the verdict names as behind. It says how late the newest block came, so the strip's colours
 * have a meaning in words, and only "Behind" when that block was on time or none landed.
 */
export function describeBehind(bars: readonly Pick<ChainBar, 'gapMs'>[], blockTimeMs: number): string {
  const newest = bars.at(-1);
  const late = newest === undefined ? 0 : newest.gapMs - blockTimeMs;
  return late <= 0 ? 'Behind' : `Behind, last block ${formatSeconds(late)} late`;
}

/**
 * The ghost bar before a chain's first bar: what it waits on and what it says. Once a block has landed it also has a
 * height, in percent.
 */
export type PendingBarView =
  { phase: 'searching'; text: string } | { phase: 'counting' | 'due'; heightPercent: number; text: string };

/**
 * The ghost bar and estimate `sinceLast` ms after the chain's last block, null before any.
 * The copy never shows zero or a negative: past the estimate it swaps to words. The bar starts at a height that still
 * reads as a bar.
 */
export function pendingBar(
  chain: Pick<ChainSummary, 'blockTimeMs' | 'phase'>,
  sinceLast: number | null,
): PendingBarView {
  if (sinceLast === null) {
    const phase = chain.phase ?? 'connecting';
    return { phase: 'searching', text: `${phase.charAt(0).toUpperCase()}${phase.slice(1)}` };
  }
  const heightPercent = Math.round(45 + Math.min(sinceLast / chain.blockTimeMs, 1) * 55);
  const leftMs = chain.blockTimeMs - sinceLast;
  return leftMs > 0
    ? { phase: 'counting', heightPercent, text: `First block in about ${String(Math.ceil(leftMs / 1000))}s` }
    : { phase: 'due', heightPercent, text: 'Due any moment' };
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

/** A chain's peers caption: what it says, its tone, which warns at zero peers, and its hover text, which names the chain. */
export function describePeers(chain: string, peers: number): { text: string; tone: 'warn' | 'default'; label: string } {
  const text = peers === 1 ? '1 peer' : `${String(peers)} peers`;
  return { text, tone: peers === 0 ? 'warn' : 'default', label: `${chain}: ${text} connected` };
}

/** Older slots fade, to half strength at the left edge. */
export function slotOpacity(slot: number): string {
  return (0.5 + (0.5 * slot) / (HISTORY_SLOTS - 1)).toFixed(2);
}

/** Whether two bar lists hold the same bar objects, so an update that landed no block changes nothing. */
export function sameBars(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((bar, i) => bar === b[i]);
}
