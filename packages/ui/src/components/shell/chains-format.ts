// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What the network popover (ChainsPopover.tsx) says, as plain functions of
// the network store's values: moved unchanged from topbar.ts, except that the
// verdict takes the chains it judges instead of reading the monitor.

import type { ChainStatus } from '../../network-monitor.js';

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

/**
 * How many marks this strip can actually show.
 *
 * Measured rather than assumed, so the history a visitor sees is exactly the
 * history that fits: widen the panel and it lengthens, narrow it and it
 * shortens. Falls back to the full set before first layout, when the strip has
 * no width to measure and every number would be a guess.
 */
export function stripCapacity(strip: HTMLElement, fallback: number): number {
  const width = strip.getBoundingClientRect().width;
  if (width <= 0) {
    return fallback;
  }
  const style = getComputedStyle(strip);
  const barWidth = Number.parseFloat(style.getPropertyValue('--chains-bar-w'));
  const gap = Number.parseFloat(style.gap);
  const step = (Number.isFinite(barWidth) ? barWidth : 4) + (Number.isFinite(gap) ? gap : 4);
  return Math.max(1, Math.floor((width + (Number.isFinite(gap) ? gap : 4)) / step));
}

/**
 * The overall verdict, from the blocks actually arriving.
 *
 * Read from arrivals rather than lifecycle milestones, which are terminal: a
 * verdict built from those latches at whatever the last chain to bootstrap
 * reported and keeps saying it after the connection dies.
 */
export function describeLiveNetwork(status: readonly ChainStatus[]): {
  text: string;
  tone: string;
} {
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
