// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A chain's health as the mobile app reads it: its live share, the predicted block time over the measured one, and
// the mark and status line that share implies.

import type { ChainView, NetworkView } from './chains.js';
import { pendingBar, type PendingBarView } from './chainStrip.js';
import { isNetworkOffline, type NetworkHealth } from './networkVerdict.js';

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
  /** The ghost bar of a chain in use with no bar yet, null otherwise. */
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

type ReadChainHealthFactsParams = {
  network: Pick<NetworkView, 'readAt' | 'verdict'>;
  health: NetworkHealth;
  now: number;
};

/** What the popover knows beside one chain, read from the network and its health as of `now`. */
export function readChainHealthFacts(
  chain: Pick<ChainView, 'label'>,
  { network, health, now }: ReadChainHealthFactsParams,
): ChainHealthFacts {
  return {
    sinceRead: now - network.readAt,
    behind: network.verdict.slow?.includes(chain.label) === true,
    offline: isNetworkOffline(health),
    unreachable: network.verdict.tone === 'unreachable',
  };
}

type HealthChain = Pick<
  ChainView,
  'reachable' | 'state' | 'bars' | 'blockTimeMs' | 'sinceLast' | 'phase' | 'syncShare'
>;

const MIN_STALL_MS = 30_000;

const MIN_STALL_BLOCKS = 10;

const HEALTHY_SHARE = 5 / 6;

/**
 * A chain's mark and status line, the first match winning: offline, no endpoint, unused, disconnected, coming up, then
 * health.
 */
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
  if (chain.state === 'down') {
    return { mark: { kind: 'unavailable' }, status: { text: 'Disconnected', tone: null }, pending: null };
  }
  // A clock that stepped back since the read must not make the bars younger than they were.
  const sinceLast = chain.sinceLast === null ? null : chain.sinceLast + Math.max(0, sinceRead);
  // The ghost bar waits for the chain's first bar whatever the status line says.
  const pending = chain.bars.length === 0 ? pendingBar(chain, sinceLast) : null;
  // The monitor's verdict and the light client's phase say whether the chain is up, never the bars it keeps.
  if (chain.phase === 'syncing') {
    // The phase says a warp runs, so the share it proved wins over a connected pool or blocks already landing.
    const text = chain.syncShare === null ? 'Syncing' : `Syncing: ${String(Math.round(chain.syncShare * 100))}%`;
    return { mark: { kind: 'connecting' }, status: { text, tone: null }, pending };
  }
  if (chain.state === 'pending' || chain.phase === 'connecting') {
    return { mark: { kind: 'connecting' }, status: { text: 'Connecting', tone: null }, pending };
  }
  return { ...describeProduction(chain, sinceLast, behind), pending };
}

/** A connected chain's mark and status line from its blocks: not producing, unmeasured, or its live share. */
function describeProduction(
  chain: HealthChain,
  sinceLast: number | null,
  behind: boolean,
): Omit<ChainHealthView, 'pending'> {
  const tone = behind ? 'warn' : null;
  if (isStalled(chain.blockTimeMs, sinceLast)) {
    return { mark: { kind: 'outage' }, status: { text: 'Not producing blocks', tone } };
  }
  const word = behind ? 'Behind' : 'Connected';
  const blockMs = measureBlockTime(chain.bars);
  if (blockMs === null) {
    return { mark: { kind: 'healthy' }, status: { text: word, tone } };
  }
  const share = Math.min(1, chain.blockTimeMs / blockMs);
  // Blocks a catching-up client hears back to back are not faster production, so Block never reads under the chain's own.
  const text = `${word} · Live ${String(Math.round(share * 100))}% · Block ~${formatDuration(chain.blockTimeMs / share)}`;
  return {
    mark: share >= HEALTHY_SHARE ? { kind: 'healthy' } : { kind: 'short', share, band: pickArcBand(share) },
    status: { text, tone },
  };
}

/** Whether no block landed for at least 30 s and 10 block times. */
function isStalled(blockTimeMs: number, sinceLast: number | null): boolean {
  return sinceLast !== null && sinceLast >= Math.max(MIN_STALL_MS, MIN_STALL_BLOCKS * blockTimeMs);
}

/** The mean of the last two block intervals, null until three blocks have landed. */
function measureBlockTime(bars: HealthChain['bars']): number | null {
  const [previous, newest] = bars.slice(-2);
  return previous === undefined || newest === undefined ? null : (previous.gapMs + newest.gapMs) / 2;
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
