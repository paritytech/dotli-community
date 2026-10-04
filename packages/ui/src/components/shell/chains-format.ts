// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What the network popover (ChainsPopover.tsx) says, as plain functions of
// the network store's values: moved unchanged from topbar.ts, except that the
// verdict takes the chains it judges instead of reading the monitor, and that
// the menu's status line (describeNetworkStatus) is built from it.

import type { Backend } from '@dotli/config';

import type { ChainStatus } from '../../network-monitor.js';
import type { StatusTone } from '../primitives/StatusDot.js';

/**
 * How the arrival of a single block reads on hover.
 *
 * The interval comes first because it is the measurement, then how far past the
 * expectation the chain declares it landed. A block inside the expectation has no delay
 * to report, and saying "0s late" would invite the reader to look for a problem
 * that is not there.
 */
export function describeBlockDelay(gapMs: number, blockTimeMs: number): string {
  const secs = (ms: number): string =>
    ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${String(Math.round(ms / 1000))}s`;
  const late = gapMs - blockTimeMs;
  return late <= 0 ? `${secs(gapMs)}, on time` : `${secs(gapMs)}, ${secs(late)} late`;
}

/** Bytes as the panel says them: kB up to a megabyte, then MB. */
export function formatSize(bytes: number): string {
  return bytes < 1_048_576 ? `${String(Math.round(bytes / 1024))} kB` : `${(bytes / 1_048_576).toFixed(1)} MB`;
}

export function formatRate(bytesPerSecond: number): string {
  // Below half a kilobyte the kB rounding reads "0 kB/s", which says the
  // opposite of what is happening: bytes are moving, just barely.
  if (bytesPerSecond < 1024) {
    return `${String(Math.round(bytesPerSecond))} B/s`;
  }
  return bytesPerSecond < 1_048_576
    ? `${String(Math.round(bytesPerSecond / 1024))} kB/s`
    : `${(bytesPerSecond / 1_048_576).toFixed(1)} MB/s`;
}

/** Slots in a chain's history strip, filled from the right as samples arrive. */
export const HISTORY_SLOTS = 48;

/** Older slots fade: half strength at the left edge, full at the newest. */
export function slotOpacity(slot: number): string {
  return (0.5 + (0.5 * slot) / (HISTORY_SLOTS - 1)).toFixed(2);
}

/** The verdict describeLiveNetwork reaches: its words, and the tone of its dot. */
export interface LiveVerdict {
  text: string;
  tone: Extract<StatusTone, 'ok' | 'warn' | 'idle'>;
  /** The chains behind a warning, by label. */
  slow?: readonly string[];
}

/**
 * The overall verdict, from the blocks actually arriving.
 *
 * Read from arrivals rather than lifecycle milestones, which are terminal: a
 * verdict built from those latches at whatever the last chain to bootstrap
 * reported and keeps saying it after the connection dies.
 */
export function describeLiveNetwork(status: readonly ChainStatus[]): LiveVerdict {
  const chains = status.filter(c => c.reachable);
  if (chains.length === 0) {
    return { text: 'Starting', tone: 'idle' };
  }
  const started = chains.filter(c => c.latest !== null);
  if (started.length === 0) {
    return { text: 'Connecting', tone: 'idle' };
  }
  const overdue = started.filter(c => c.sinceLast !== null && c.sinceLast > c.blockTimeMs * 3);
  if (overdue.length > 0) {
    return {
      text: `Waiting on ${overdue.map(c => c.label).join(' and ')}`,
      tone: 'warn',
      slow: overdue.map(c => c.label),
    };
  }
  if (started.length < chains.length) {
    return {
      text: `Connecting, ${String(started.length)} of ${String(chains.length)} ready`,
      tone: 'idle',
    };
  }
  return { text: 'Your connection is good', tone: 'ok' };
}

/** The network menu's status line: a title, and the verdict's own words where they add to it. */
export interface NetworkStatusLine {
  tone: StatusTone;
  title: string;
  detail: string | null;
}

const UNSETTLED_TITLES: Record<'idle' | 'warn', string> = {
  idle: 'Syncing',
  warn: 'Connection is unstable',
};

const NUMBER_WORDS = ['two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];

/** "A", "A and B", "A, B and C". */
function joinNames(names: readonly string[]): string {
  return names.length < 2 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1) ?? ''}`;
}

/** "in sync", "in sync on both chains", "in sync on all four chains". */
function inSync(chainCount: number): string {
  if (chainCount < 2) {
    return 'in sync';
  }
  if (chainCount === 2) {
    return 'in sync on both chains';
  }
  return `in sync on all ${NUMBER_WORDS[chainCount - 2] ?? String(chainCount)} chains`;
}

/** The captions per backend: the gateway has no peers and verifies nothing, so it says neither. */
interface Captions {
  offline: string;
  ok: (chainCount: number) => string;
  slow: (names: readonly string[]) => string;
  starting: string;
}

const LIGHT_CLIENT: Captions = {
  offline: 'No peers on any chain. Retrying.',
  ok: chainCount => `Light client is ${inSync(chainCount)}`,
  slow: names => `${joinNames(names)} ${names.length === 1 ? 'is' : 'are'} short on peers`,
  starting: 'Finding peers. This takes a few seconds.',
};

const GATEWAY: Captions = {
  offline: 'Trusted providers are out of reach. Retrying.',
  ok: () => 'Served by trusted providers',
  slow: names => `${joinNames(names)} ${names.length === 1 ? 'is' : 'are'} behind`,
  starting: 'Reaching trusted providers. This takes a few seconds.',
};

/**
 * The network menu's status line, from the verdict, the browser's online
 * state and the backend serving the chains.
 *
 * Offline wins, as it does for the capsule and the network badge, so the three
 * never disagree: blocks that landed before the connection dropped would
 * otherwise still read as a good connection. Every state carries a caption.
 */
export function describeNetworkStatus(
  verdict: LiveVerdict,
  offline: boolean,
  chainCount = 0,
  backend?: Backend,
): NetworkStatusLine {
  const captions = backend === 'rpc-gateway' ? GATEWAY : LIGHT_CLIENT;
  if (offline) {
    return { tone: 'err', title: 'You are offline', detail: captions.offline };
  }
  const { text, tone, slow } = verdict;
  if (tone === 'ok') {
    return { tone, title: text, detail: captions.ok(chainCount) };
  }
  if (tone === 'warn') {
    return { tone, title: UNSETTLED_TITLES[tone], detail: captions.slow(slow ?? []) };
  }
  return { tone, title: UNSETTLED_TITLES[tone], detail: captions.starting };
}
