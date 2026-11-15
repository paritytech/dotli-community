// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The performance runs' saved results: the phases a run measures, the files that keep the runs, their format, and how
// a report reads and prints them.

import * as fs from 'node:fs';
import * as path from 'node:path';

/** The phase that spans the whole load, which a report sums a run up by. */
export const TOTAL_PHASE = 'End-to-end';

/** A measured phase: its name, which keys its saved results, how deep it nests in the table, and its two marks. */
type Phase = { name: string; depth: number; startMark: string; endMark: string };

/** Each phase in report order. */
export const PHASES: readonly Phase[] = [
  { name: TOTAL_PHASE, depth: 0, startMark: 'dotli:main:start', endMark: 'dotli:app:end' },
  { name: 'Host total', depth: 0, startMark: 'dotli:main:start', endMark: 'dotli:main:end' },
  { name: 'SW registration', depth: 0, startMark: 'dotli:sw:start', endMark: 'dotli:sw:end' },
  { name: 'Name resolution', depth: 0, startMark: 'dotli:resolve:start', endMark: 'dotli:resolve:end' },
  { name: 'Smoldot init', depth: 1, startMark: 'dotli:smoldot:init:start', endMark: 'dotli:smoldot:init:end' },
  { name: 'Relay chain', depth: 2, startMark: 'dotli:smoldot:relay:start', endMark: 'dotli:smoldot:relay:end' },
  { name: 'Parachain', depth: 2, startMark: 'dotli:smoldot:parachain:start', endMark: 'dotli:smoldot:parachain:end' },
  { name: 'Chain sync', depth: 2, startMark: 'dotli:smoldot:sync:start', endMark: 'dotli:smoldot:sync:end' },
  { name: 'SW smoldot', depth: 1, startMark: 'dotli:smoldot:sw:start', endMark: 'dotli:smoldot:sw:end' },
  { name: 'App total', depth: 0, startMark: 'dotli:app:start', endMark: 'dotli:app:end' },
  { name: 'P2P attempt', depth: 1, startMark: 'dotli:fetch:p2p:start', endMark: 'dotli:fetch:p2p:end' },
  { name: 'Gateway fetch', depth: 1, startMark: 'dotli:fetch:gateway:start', endMark: 'dotli:fetch:gateway:end' },
  { name: 'Archive parse', depth: 1, startMark: 'dotli:fetch:parse:start', endMark: 'dotli:fetch:parse:end' },
];

const RESULTS_DIR = path.join(import.meta.dirname, 'results');

export const BASE_FILE = path.join(RESULTS_DIR, 'base.json');

export const LAST_FILE = path.join(RESULTS_DIR, 'last.json');

export type PhaseStats = {
  p50: number;
  p95: number;
  p99: number;
  mean: number;
  stddev: number;
  /** The coefficient of variation, stddev over mean. */
  cv: number;
  min: number;
  max: number;
  values: number[];
  discarded: number; // iterations removed as outliers (> 2x best time)
};

export type RunStats = {
  timestamp: string;
  iterations: number;
  phases: Record<string, PhaseStats>;
  browserMetrics: {
    domContentLoaded: PhaseStats;
    jsHeapUsed: PhaseStats;
  };
  networkStats: {
    requestCount: PhaseStats;
    totalBytes: PhaseStats;
  };
};

export type SavedResults = {
  cold: RunStats | null;
  warm: RunStats | null;
  lukewarm: RunStats | null;
};

/** A kind of run, the key it is saved under. */
export type RunKind = keyof SavedResults;

/** Over this cv a phase is noisy, and its results may not be reliable. */
export const NOISY_CV = 0.3;

/** Over this cv a phase is very noisy. */
export const VERY_NOISY_CV = 0.5;

/** The results saved at `filepath`, or null when none were saved. Throws when the file is not valid JSON. */
export function loadResults(filepath: string): SavedResults | null {
  return fs.existsSync(filepath) ? (JSON.parse(fs.readFileSync(filepath, 'utf-8')) as SavedResults) : null;
}

export function saveResults(filepath: string, data: SavedResults): void {
  fs.mkdirSync(path.dirname(filepath), { recursive: true });
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
}

/** The phase's name indented by how deep it nests, for a console table. */
export function indentPhase(name: string): string {
  const depth = PHASES.find(phase => phase.name === name)?.depth ?? 0;
  return `${'  '.repeat(depth)}${name}`;
}

/** A duration in ms, in seconds from one second either way. */
export function fmt(ms: number): string {
  if (Math.abs(ms) < 1000) {
    return `${String(ms)}ms`;
  }
  return `${(ms / 1000).toFixed(2)}s`;
}

/** How far `current` moved from `reference`, in percent, or N/A from a zero reference. */
export function fmtPct(current: number, reference: number): string {
  if (reference === 0) {
    return 'N/A';
  }
  const pct = ((current - reference) / reference) * 100;
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
}

/** How far `current` moved from `reference`, as a duration with its percent. */
export function fmtDelta(current: number, reference: number): string {
  const diff = current - reference;
  const sign = diff > 0 ? '+' : '';
  return `${sign}${fmt(diff)} (${fmtPct(current, reference)})`;
}
