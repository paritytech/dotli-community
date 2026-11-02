// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Plain values, so a redraw writes only the ones that changed.

import { formatRate, formatSize } from '@dotli/shared';
import type { CacheResult, ResolutionModel, ResolutionSummary } from '../model/buildResolution.js';
import { formatCount } from '../model/formatCount.js';
import { formatMs } from './formatMs.js';

type FactTone = 'ok' | 'warn' | 'bad' | 'running' | 'dim';

type FactValue = {
  text: string;
  tone?: FactTone;
  tooltip?: string;
};

/** One KPI card. `hint` is the only place on screen that disambiguates similar facts. */
type Fact = {
  key: string;
  value: FactValue;
  hint: string;
};

/** What a fact shows while its value is not known. */
const UNKNOWN_TEXT = '—';

/** The load's KPI cards, in the order the Resolution summary shows them. Never throws. */
export function listSummaryFacts(model: ResolutionModel): Fact[] {
  const summary = model.summary;
  return [
    {
      key: 'name',
      value: { text: summary.label ?? UNKNOWN_TEXT },
      hint: 'The .dot name this page load resolved.',
    },
    {
      key: 'outcome',
      value: toOutcomeFact(summary),
      hint: 'How far the load got. “Resolved” means a content id was found for the name. That alone does not mean the app rendered. Read “app on screen” for that.',
    },
    {
      key: 'network transport',
      value: toTransportFact(summary),
      hint: 'How this load reached the chain. The smoldot light client verifies blocks itself. The RPC gateway trusts a remote node to answer honestly.',
    },
    {
      key: 'elapsed',
      value: { text: formatMs(model.elapsedMs) },
      hint: 'The duration of the whole load, from the host starting up to the app being on screen.',
    },
    {
      key: 'resolved in',
      value: { text: formatKnown(summary.resolveMs, formatMs) },
      hint: 'How long it took to turn the name into a content id. On a cache hit this is the moment the stored id was read, not a chain lookup.',
    },
    {
      key: 'app on screen',
      value: { text: formatKnown(summary.renderedMs, formatMs) },
      hint: 'When the sandbox wrote the app document. This is the app actually visible, not the iframe being created, which happens seconds earlier on a cold load.',
    },
    {
      key: 'first byte',
      value: { text: formatKnown(summary.firstByteMs, formatMs) },
      hint: 'Roughly when data first moved. The byte counter is sampled about once a second, so treat this as an upper bound. Everything before it is finding peers and opening connections.',
    },
    {
      key: 'downloaded during connection',
      value: { text: formatKnown(summary.totalBytes, formatSize) },
      hint: 'Every byte the light client pulled off the network, counted from boot until the app frame was attached.',
    },
    {
      key: 'app size',
      value: { text: formatAppSize(summary) },
      hint: "How big the app is once unpacked, and how many files it came in. Its blocks came over the connections the light client already holds, or straight from blocks the host's block cache already had.",
    },
    {
      key: 'average speed',
      value: { text: formatKnown(summary.averageBytesPerSecond, formatRate) },
      hint: 'The bytes downloaded during connection divided by the time they took to arrive. The wait before any data moved is included, so it reads lower than the real link speed.',
    },
    {
      key: 'peak speed',
      value: { text: formatKnown(summary.peakBytesPerSecond, formatRate) },
      hint: 'The best rate seen between two byte samples, taken about a second apart. That makes it a one-second average, not a true peak.',
    },
    {
      key: 'CID cache',
      value: toCacheFact(summary.cidCache),
      hint: 'Whether the content id for this name was already saved from an earlier visit, letting the load skip the chain lookup entirely. “Skipped” means the cache is turned off in settings.',
    },
    {
      key: 'archive cache',
      value: toCacheFact(summary.archiveCache),
      hint: "Whether the blocks the app needed were already in the host's block cache, so nothing had to be fetched from the network. “Skipped” means the cache is turned off in settings.",
    },
  ];
}

function toOutcomeFact(summary: ResolutionSummary): FactValue {
  switch (summary.outcome) {
    case 'running':
      return { text: 'still running', tone: 'running' };
    case 'resolved':
      return { text: 'resolved', tone: 'ok' };
    case 'empty':
      return { text: 'no content set', tone: 'warn' };
    case 'failed':
      return { text: 'failed', tone: 'bad', tooltip: summary.failureReason ?? 'no reason reported' };
  }
}

function toTransportFact(summary: ResolutionSummary): FactValue {
  switch (summary.backend) {
    case 'smoldot':
      return { text: 'smoldot light client' };
    case 'rpc-gateway':
      return { text: 'RPC gateway' };
    case null:
      return { text: 'not reported', tone: 'dim' };
  }
}

function formatAppSize(summary: ResolutionSummary): string {
  if (summary.appBytes === null) {
    return UNKNOWN_TEXT;
  }
  const files = summary.appFileCount;
  if (files === null) {
    return formatSize(summary.appBytes);
  }
  return `${formatSize(summary.appBytes)} in ${formatCount(files, 'file')}`;
}

/** `value` through `format`, or a dash when it is not known. Never throws. */
function formatKnown(value: number | null, format: (known: number) => string): string {
  return value === null ? UNKNOWN_TEXT : format(value);
}

function toCacheFact(result: CacheResult): FactValue {
  switch (result) {
    case null:
      return { text: 'not reported', tone: 'dim' };
    case 'hit':
      return { text: 'hit', tone: 'ok' };
    case 'skipped':
      return { text: 'skipped (turned off)', tone: 'dim' };
    case 'miss':
      return { text: 'miss', tone: 'dim' };
  }
}
