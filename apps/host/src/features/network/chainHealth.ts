// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A chain's health as the mobile app reads it: the share of its predicted blocks produced over the last window, and
// the mark and status line that share implies.

import type { ChainView } from './chains.js';
import { pendingBar, type PendingBarView } from './chainStrip.js';

/** The colour of a short chain's arc. */
export type ArcBand = 'plain' | 'warn' | 'err';

/** The mark drawn around a chain's glyph. A short chain fills its arc to `share`, above 0 and under the healthy share. */
export type ChainMark =
  | { kind: 'healthy' }
  | { kind: 'short'; share: number; band: ArcBand }
  | { kind: 'outage' }
  | { kind: 'connecting' }
  | { kind: 'unavailable' }
  | { kind: 'unused' };

export type ChainHealthView = {
  mark: ChainMark;
  status: { text: string; tone: 'warn' | 'err' | null };
  /** The ghost bar of a connecting chain, null otherwise. */
  pending: PendingBarView | null;
};

/** What the popover knows beside the chain itself. */
export type ChainHealthFacts = {
  /** Since `NetworkView.readAt`, so the bars' ages move on between reads. */
  sinceRead: number;
  /** Whether the verdict names this chain as slow. */
  behind: boolean;
  offline: boolean;
  /** Whether the verdict finds the whole network out of reach. */
  unreachable: boolean;
};

type HealthChain = Pick<ChainView, 'reachable' | 'state' | 'bars' | 'blockTimeMs' | 'sinceLast' | 'phase'>;

const MIN_WINDOW_MS = 30_000;

const MIN_WINDOW_BLOCKS = 10;

const HEALTHY_SHARE = 5 / 6;

/** A chain's mark and status line, the first match winning: offline, no endpoint, unused, no block yet, then health. */
export function describeChainHealth(
  chain: HealthChain,
  { sinceRead, behind, offline, unreachable }: ChainHealthFacts,
): ChainHealthView {
  if (offline) {
    return { mark: { kind: 'unavailable' }, status: { text: 'No internet', tone: null }, pending: null };
  }
  if (!chain.reachable) {
    return {
      mark: { kind: 'unavailable' },
      status: { text: 'No endpoint', tone: unreachable ? 'err' : 'warn' },
      pending: null,
    };
  }
  if (chain.state === 'unused') {
    return { mark: { kind: 'unused' }, status: { text: 'Not in use', tone: null }, pending: null };
  }
  // A clock that stepped back since the read must not make the bars younger than they were.
  const sinceLast = chain.sinceLast === null ? null : chain.sinceLast + Math.max(0, sinceRead);
  if (chain.bars.length === 0) {
    const pending = pendingBar(chain, sinceLast);
    return { mark: { kind: 'connecting' }, status: { text: pending.text, tone: null }, pending };
  }
  const tone = behind ? 'warn' : null;
  const share = measureShare(chain, sinceLast);
  if (share === 0) {
    return { mark: { kind: 'outage' }, status: { text: 'Not producing blocks', tone }, pending: null };
  }
  const word = behind ? 'Behind' : 'Connected';
  if (share === null) {
    return { mark: { kind: 'healthy' }, status: { text: word, tone }, pending: null };
  }
  const text = `${word} · Live ${String(Math.round(share * 100))}% · Block ~${formatDuration(chain.blockTimeMs / share)}`;
  return {
    mark: share >= HEALTHY_SHARE ? { kind: 'healthy' } : { kind: 'short', share, band: pickArcBand(share) },
    status: { text, tone },
    pending: null,
  };
}

/**
 * The share of predicted blocks produced over the last window, null until the bars span it or with no last block. The
 * window is measured from the newest bar at or before its start, so a stall past the window reads as nothing produced.
 */
function measureShare(chain: HealthChain, sinceLast: number | null): number | null {
  const { bars, blockTimeMs } = chain;
  const newest = bars.at(-1);
  if (sinceLast === null || newest === undefined) {
    return null;
  }
  const windowMs = Math.max(MIN_WINDOW_MS, MIN_WINDOW_BLOCKS * blockTimeMs);
  const expected = Math.floor(windowMs / blockTimeMs);
  // Each bar is older than the next one by that next bar's gap.
  let age = sinceLast;
  for (const bar of [...bars].reverse()) {
    if (age >= windowMs) {
      return Math.min(Math.max(newest.number - bar.number, 0), expected) / expected;
    }
    age += bar.gapMs;
  }
  return null;
}

function pickArcBand(share: number): ArcBand {
  if (share < 0.25) {
    return 'err';
  }
  return share < 0.5 ? 'warn' : 'plain';
}

/** Whole seconds, with minutes from a minute up. */
function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${String(seconds)}s` : `${String(Math.floor(seconds / 60))}m ${String(seconds % 60)}s`;
}
