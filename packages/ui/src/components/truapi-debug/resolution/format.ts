// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Plain values, so a redraw writes only the ones that changed.

import type {
  CacheResult,
  ResolutionBlock,
  ResolutionModel,
  ResolutionRow,
  ResolutionSummary,
} from '@dotli/truapi-debug';

type FactTone = 'ok' | 'warn' | 'bad' | 'running' | 'dim';

interface FactValue {
  text: string;
  tone?: FactTone;
  tooltip?: string;
}

/**
 * One KPI card. `hint` is the plain-English explanation shown on hover, which is
 * the only place several of these are disambiguated: `sync download` counts
 * chain traffic and `app size` counts the dApp files, and nothing else on
 * screen says so.
 */
interface Fact {
  key: string;
  value: FactValue;
  hint: string;
}

export function summaryFacts(model: ResolutionModel): Fact[] {
  const s = model.summary;
  return [
    {
      key: 'name',
      value: { text: s.label ?? '—' },
      hint: 'The .dot name this page load resolved.',
    },
    {
      key: 'outcome',
      value: outcomeValue(s),
      hint: 'How far the load got. “Resolved” means a content id was found for the name. That alone does not mean the app rendered. Read “app on screen” for that.',
    },
    {
      key: 'network transport',
      value: transportValue(s),
      hint: 'How this load reached the chain. The smoldot light client verifies blocks itself. The RPC gateway trusts a remote node to answer honestly.',
    },
    {
      key: 'elapsed',
      value: { text: formatMs(model.elapsedMs) },
      hint: 'The duration of the whole load, from the host starting up to the app being on screen.',
    },
    {
      key: 'resolved in',
      value: { text: s.resolveMs === null ? '—' : formatMs(s.resolveMs) },
      hint: 'How long it took to turn the name into a content id. On a cache hit this is the moment the stored id was read, not a chain lookup.',
    },
    {
      key: 'app on screen',
      value: { text: s.renderedMs === null ? '—' : formatMs(s.renderedMs) },
      hint: 'When the sandbox wrote the app document. This is the app actually visible, not the iframe being created, which happens seconds earlier on a cold load.',
    },
    {
      key: 'first byte',
      value: { text: s.firstByteMs === null ? '—' : formatMs(s.firstByteMs) },
      hint: 'Roughly when data first moved. The byte counter is sampled about once a second, so treat this as an upper bound. Everything before it is finding peers and opening connections.',
    },
    {
      key: 'downloaded during connection',
      value: { text: s.totalBytes === null ? '—' : formatBytes(s.totalBytes) },
      hint: 'Every byte the light client pulled off the network, counted from boot until the app frame was attached.',
    },
    {
      key: 'app size',
      value: { text: appSizeText(s) },
      hint: "How big the app is once unpacked, and how many files it came in. Its blocks came over the connections the light client already holds, or straight from blocks the host's block cache already had.",
    },
    {
      key: 'average speed',
      value: { text: formatRate(s.avgBytesPerSecond) },
      hint: 'The bytes downloaded during connection divided by the time they took to arrive. The wait before any data moved is included, so it reads lower than the real link speed.',
    },
    {
      key: 'peak speed',
      value: { text: formatRate(s.peakBytesPerSecond) },
      hint: 'The best rate seen between two byte samples, taken about a second apart. That makes it a one-second average, not a true peak.',
    },
    {
      key: 'CID cache',
      value: cacheValue(s.cidCache),
      hint: 'Whether the content id for this name was already saved from an earlier visit, letting the load skip the chain lookup entirely. “Skipped” means the cache is turned off in settings.',
    },
    {
      key: 'archive cache',
      value: cacheValue(s.archiveCache),
      hint: "Whether the blocks the app needed were already in the host's block cache, so nothing had to be fetched from the network. “Skipped” means the cache is turned off in settings.",
    },
  ];
}

function outcomeValue(s: ResolutionSummary): FactValue {
  switch (s.outcome) {
    case 'running':
      return { text: 'still running', tone: 'running' };
    case 'resolved':
      return { text: 'resolved', tone: 'ok' };
    case 'empty':
      return { text: 'no content set', tone: 'warn' };
    case 'failed':
      return { text: 'failed', tone: 'bad', tooltip: s.failureReason ?? 'no reason reported' };
  }
}

function transportValue(s: ResolutionSummary): FactValue {
  switch (s.backend) {
    case 'smoldot':
      return { text: 'smoldot light client' };
    case 'rpc-gateway':
      return { text: 'RPC gateway' };
    case null:
      return { text: 'not reported', tone: 'dim' };
  }
}

function appSizeText(s: ResolutionSummary): string {
  if (s.appBytes === null) {
    return '—';
  }
  const files = s.appFileCount;
  if (files === null) {
    return formatBytes(s.appBytes);
  }
  return `${formatBytes(s.appBytes)} in ${String(files)} file${files === 1 ? '' : 's'}`;
}

function cacheValue(result: CacheResult): FactValue {
  if (result === null) {
    return { text: 'not reported', tone: 'dim' };
  }
  if (result === 'hit') {
    return { text: 'hit', tone: 'ok' };
  }
  if (result === 'skipped') {
    return { text: 'skipped (turned off)', tone: 'dim' };
  }
  return { text: 'miss', tone: 'dim' };
}

const AXIS_TICKS = 5;

interface AxisTick {
  left: string;
  label: string;
}

export function axisTicks(span: number): AxisTick[] {
  return Array.from({ length: AXIS_TICKS + 1 }, (_, i) => ({
    left: `${((i / AXIS_TICKS) * 100).toFixed(3)}%`,
    label: formatMs((span * i) / AXIS_TICKS),
  }));
}

/** Phases with a colour of their own; anything else falls back to neutral. */
const COLOURED_PHASES = new Set(['connecting', 'syncing', 'ready', 'stalled']);

interface BlockView {
  phase: string;
  /** The phase colour: the phase itself, or `unknown`. */
  tone: string;
  left: string;
  width: string;
  open: boolean;
  title: string;
}

export function blockView(b: ResolutionBlock, open: boolean, span: number): BlockView {
  const end = b.endMs ?? span;
  const left = (b.startMs / span) * 100;
  const width = Math.max(0.4, ((end - b.startMs) / span) * 100);
  const title = [
    `${b.phase} for ${formatMs(end - b.startMs)}`,
    `from ${formatMs(b.startMs)} to ${open ? 'now' : formatMs(end)}`,
    b.reason,
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
  return {
    phase: b.phase,
    tone: COLOURED_PHASES.has(b.phase) ? b.phase : 'unknown',
    left: `${left.toFixed(3)}%`,
    width: `${width.toFixed(3)}%`,
    open,
    title,
  };
}

export function rowMeta(row: ResolutionRow): string {
  const parts: string[] = [];
  if (row.peers !== null) {
    parts.push(`${String(row.peers)} peer${row.peers === 1 ? '' : 's'}`);
  }
  if (row.warpAt !== null && row.warpTarget !== null) {
    parts.push(`warped to ${String(row.warpAt)} of ${String(row.warpTarget)}`);
  }
  if (row.dbCache !== null) {
    parts.push(`db ${row.dbCache}`);
  }
  return parts.join(' · ');
}

function formatMs(ms: number): string {
  if (ms < 1000) {
    return `${String(Math.round(ms))}ms`;
  }
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${String(Math.round(bytes))} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatRate(bytesPerSecond: number | null): string {
  if (bytesPerSecond === null) {
    return '—';
  }
  return `${formatBytes(bytesPerSecond)}/s`;
}
