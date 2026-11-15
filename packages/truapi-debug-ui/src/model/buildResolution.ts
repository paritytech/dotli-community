// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// One page load as a row of phase blocks per chain role, plus whole-load figures.

import { CHAIN_ROLE_LABELS, CHAIN_ROLES, type ChainRole, hasLightClient, parseBackend } from '@dotli/config';
import type { DotliDebugEvent } from '@dotli/truapi-debug';
import { getSystemEventKey } from './getSystemEventKey.js';

/** A block still running ends at the end of the load. */
export type ResolutionBlock = {
  phase: string;
  startMs: number;
  endMs: number;
  reason: string | null;
};

export type ResolutionRow = {
  role: ChainRole;
  label: string;
  blocks: ResolutionBlock[];
  /**
   * The most peers the chain had in the load. Peers often arrive a beat after `ready`, and a chain that dropped them
   * later was not a zero-peer chain for this load.
   */
  peers: number | null;
  warpAt: number | null;
  warpTarget: number | null;
  dbCache: Exclude<CacheResult, 'skipped'>;
};

export type CacheResult = 'hit' | 'miss' | 'skipped' | null;

export type ResolutionSummary = {
  backend: 'smoldot' | 'rpc-gateway' | null;
  outcome: 'running' | 'resolved' | 'empty' | 'failed';
  failureReason: string | null;
  label: string | null;
  cid: string | null;
  resolveMs: number | null;
  renderedMs: number | null;
  totalBytes: number | null;
  appBytes: number | null;
  appFileCount: number | null;
  averageBytesPerSecond: number | null;
  peakBytesPerSecond: number | null;
  firstByteMs: number | null;
  cidCache: CacheResult;
  archiveCache: CacheResult;
};

export type ResolutionModel = {
  flowId: string | null;
  startedAt: number;
  elapsedMs: number;
  rows: ResolutionRow[];
  summary: ResolutionSummary;
};

type BuildRowsParams = {
  /** The load's events, up to its end. */
  events: readonly DotliDebugEvent[];
  startedAt: number;
  /** The load's length. */
  elapsedMs: number;
};

/** A running byte count, `at` ms into the load. */
type ByteCount = {
  at: number;
  total: number;
};

const LOAD_END_GRACE_MS = 30_000;

/**
 * The newest load in `events` as of `now`. Anchored on the newest `boot:started`, not one `flowId`, because boot,
 * resolve and render each mint their own flow.
 */
export function buildResolution(events: readonly DotliDebugEvent[], now: number): ResolutionModel {
  let bootAt = -1;
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event?.layer === 'boot' && event.event === 'started') {
      bootAt = index;
      break;
    }
  }
  const load = bootAt === -1 ? events : events.slice(bootAt);
  const first = load[0];
  if (first === undefined) {
    return {
      flowId: null,
      startedAt: now,
      elapsedMs: 0,
      rows: [],
      summary: createEmptySummary(),
    };
  }
  const startedAt = first.timestamp;
  const loadEnd = findLoadEnd(load);
  const endedAt = loadEnd ?? now;
  const elapsedMs = Math.max(0, endedAt - startedAt);
  // Chains keep reporting after the app is on screen, so bound the window at the load's end.
  const mine = load.filter(e => e.timestamp <= endedAt);
  return {
    flowId: first.flowId,
    startedAt,
    elapsedMs,
    rows: buildRows({ events: mine, startedAt, elapsedMs }),
    summary: buildSummary(mine, startedAt, loadEnd !== null),
  };
}

function isLoadEndEvent(event: DotliDebugEvent): boolean {
  // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check -- only these events end a load, every other one goes on
  switch (getSystemEventKey(event)) {
    case 'render:iframe_ready':
    case 'boot:ready':
    case 'boot:failed':
    case 'resolve:completed':
    case 'resolve:failed':
      return true;
    default:
      return false;
  }
}

/** When the load ended, or null while no event has ended it. */
function findLoadEnd(load: readonly DotliDebugEvent[]): number | null {
  let last: number | null = null;
  let lastChainPhase = 0;
  let lastSandbox = 0;
  for (const event of load) {
    if (isLoadEndEvent(event)) {
      last = Math.max(last ?? event.timestamp, event.timestamp);
    }
    if (event.layer === 'chain' && event.event === 'phase') {
      lastChainPhase = Math.max(lastChainPhase, event.timestamp);
    }
    if (event.layer === 'sandbox') {
      lastSandbox = Math.max(lastSandbox, event.timestamp);
    }
  }
  if (last === null) {
    return null;
  }
  // A cached load paints while every chain is still connecting and before the sandbox reports its cache
  // answer, so both may extend the window, capped so the chart settles.
  const grace = last + LOAD_END_GRACE_MS;
  return Math.max(last, Math.min(lastChainPhase, grace), Math.min(lastSandbox, grace));
}

function buildRows({ events, startedAt, elapsedMs }: BuildRowsParams): ResolutionRow[] {
  // In role order, so the rows come out in that order. An event whose chain names no role has no row.
  return CHAIN_ROLES.map(role => {
    const chainEvents = events.filter(event => event.layer === 'chain' && readField(event, 'chain') === role);
    const phases = chainEvents.filter(event => event.event === 'phase');
    return {
      role,
      label: CHAIN_ROLE_LABELS[role],
      blocks: buildBlocks(phases, startedAt, elapsedMs),
      peers: findMostPeers(chainEvents),
      warpAt: findLastNumber(phases, 'warpAt'),
      warpTarget: findLastNumber(phases, 'warpTarget'),
      dbCache: findDbCache(chainEvents),
    };
  });
}

/** A block for each phase the chain entered, running until the next one, and the last until `span`, the load's length. */
function buildBlocks(phases: readonly DotliDebugEvent[], startedAt: number, span: number): ResolutionBlock[] {
  const starts: Omit<ResolutionBlock, 'endMs'>[] = [];
  for (const event of phases) {
    const phase = readString(readField(event, 'phase')) ?? 'unknown';
    // A warp update within the same phase keeps the block running instead of splitting it.
    if (starts.at(-1)?.phase === phase) {
      continue;
    }
    starts.push({
      phase,
      startMs: Math.max(0, event.timestamp - startedAt),
      reason: readString(readField(event, 'reason')),
    });
  }
  return starts.map((block, index) => ({
    ...block,
    endMs: starts[index + 1]?.startMs ?? Math.max(block.startMs, span),
  }));
}

/** The most peers any of `events` reports, or null when none reports a count. */
function findMostPeers(events: readonly DotliDebugEvent[]): number | null {
  const counts = events.map(event => readNumber(readField(event, 'peers'))).filter(count => count !== null);
  return counts.length === 0 ? null : counts.reduce((most, count) => Math.max(most, count), 0);
}

/** The last number any of `events` reports under `name`, or null when none does. */
function findLastNumber(events: readonly DotliDebugEvent[], name: string): number | null {
  let last: number | null = null;
  for (const event of events) {
    last = readNumber(readField(event, name)) ?? last;
  }
  return last;
}

/** The chain's first cache answer, so a later report cannot change the load's cache result. */
function findDbCache(events: readonly DotliDebugEvent[]): ResolutionRow['dbCache'] {
  const answers = events.filter(event => event.event === 'dbcache').map(event => readField(event, 'dbCache'));
  return answers.find(answer => answer === 'hit' || answer === 'miss') ?? null;
}

function createEmptySummary(): ResolutionSummary {
  return {
    backend: null,
    outcome: 'running',
    failureReason: null,
    label: null,
    cid: null,
    resolveMs: null,
    renderedMs: null,
    totalBytes: null,
    appBytes: null,
    appFileCount: null,
    averageBytesPerSecond: null,
    peakBytesPerSecond: null,
    firstByteMs: null,
    cidCache: null,
    archiveCache: null,
  };
}

function buildSummary(mine: readonly DotliDebugEvent[], startedAt: number, ended: boolean): ResolutionSummary {
  let summary = createEmptySummary();
  const byteCounts: ByteCount[] = [];
  let paintedMs: number | null = null;
  let frameReadyMs: number | null = null;
  let bootReadyMs: number | null = null;

  for (const event of mine) {
    const payload: Record<string, unknown> = event.payload;
    const at = Math.max(0, event.timestamp - startedAt);
    // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check -- only some events change a resolution, every other one changes nothing
    switch (getSystemEventKey(event)) {
      case 'resolve:started':
        summary = applyResolveSource(summary, payload);
        break;
      case 'resolve:completed': {
        const cid = readString(payload['cid']);
        summary = {
          ...applyResolveSource(summary, payload),
          cid,
          resolveMs: readNumber(payload['durationMs']),
          outcome: getResolvedOutcome(cid),
        };
        break;
      }
      case 'resolve:failed':
        summary = {
          ...summary,
          outcome: 'failed',
          failureReason: readString(payload['reason']),
          label: readString(payload['label']) ?? summary.label,
        };
        break;
      case 'boot:failed':
        summary = { ...summary, outcome: 'failed', failureReason: readString(payload['reason']) };
        break;
      case 'render:iframe_ready':
        frameReadyMs = at;
        break;
      case 'boot:ready':
        bootReadyMs ??= at;
        break;
      case 'boot:started':
        summary = applyBootStarted(summary, payload);
        break;
      case 'boot:cid_cache_checked':
        summary = applyCidCacheChecked(summary, payload, at);
        break;
      case 'boot:block_cache':
        summary = { ...summary, archiveCache: getBlockCacheResult(payload) };
        break;
      case 'sandbox:document_written':
        summary = {
          ...summary,
          appBytes: readNumber(payload['bytes']),
          appFileCount: readNumber(payload['fileCount']),
        };
        paintedMs = at;
        break;
      case 'failover:chain_backend':
        summary = { ...summary, backend: readTransport(payload['to']) ?? summary.backend };
        break;
      case 'chain:bytes': {
        const total = readNumber(payload['received']);
        if (total !== null) {
          byteCounts.push({ at, total });
        }
        break;
      }
      default:
        break;
    }
  }

  return {
    ...summary,
    // A cached resolution emits no `resolve:completed`, so the product being on screen ends the load.
    outcome: summary.outcome === 'running' && ended ? getResolvedOutcome(summary.cid) : summary.outcome,
    // The sandbox writing its document is the real paint. `render:iframe_ready` is only the frame attach, and
    // `boot:ready` stands in for a load whose render event never reached the recorder.
    renderedMs: paintedMs ?? frameReadyMs ?? bootReadyMs,
    ...getByteFigures(byteCounts),
  };
}

/** `summary` with the transport and name a resolve event reports, where it reports them. */
function applyResolveSource(summary: ResolutionSummary, payload: Record<string, unknown>): ResolutionSummary {
  return {
    ...summary,
    backend: toChainBackend(payload['source']) ?? summary.backend,
    label: readString(payload['label']) ?? summary.label,
  };
}

function getResolvedOutcome(cid: string | null): ResolutionSummary['outcome'] {
  return cid === null ? 'empty' : 'resolved';
}

/** `summary` with the transport a load starts on and the caches the user turned off. */
function applyBootStarted(summary: ResolutionSummary, payload: Record<string, unknown>): ResolutionSummary {
  return {
    ...summary,
    // Authoritative, because a load served from the CID cache emits no resolve event.
    backend: readTransport(payload['chainBackend']) ?? summary.backend,
    // A cache the user turned off never reports a result.
    cidCache: payload['skipCidCache'] === true ? 'skipped' : summary.cidCache,
    archiveCache: payload['skipArchiveCache'] === true ? 'skipped' : summary.archiveCache,
  };
}

/** `summary` with the CID cache's answer, checked `at` ms into the load. */
function applyCidCacheChecked(
  summary: ResolutionSummary,
  payload: Record<string, unknown>,
  at: number,
): ResolutionSummary {
  if (payload['hit'] !== true) {
    return { ...summary, cidCache: 'miss' };
  }
  // A cache hit resolves the name without a `resolve:completed` event.
  return {
    ...summary,
    cidCache: 'hit',
    cid: summary.cid ?? readString(payload['cid']),
    label: summary.label ?? readString(payload['label']),
    resolveMs: summary.resolveMs ?? at,
  };
}

/** A hit only when the block cache served at least one block and missed none. */
function getBlockCacheResult(payload: Record<string, unknown>): 'hit' | 'miss' {
  return readNumber(payload['misses']) === 0 && (readNumber(payload['hits']) ?? 0) > 0 ? 'hit' : 'miss';
}

/** The load's byte figures from its running byte counts, in event order, all null when it has none. */
function getByteFigures(
  counts: readonly ByteCount[],
): Pick<ResolutionSummary, 'totalBytes' | 'firstByteMs' | 'peakBytesPerSecond' | 'averageBytesPerSecond'> {
  const last = counts.at(-1);
  if (last === undefined) {
    return { totalBytes: null, firstByteMs: null, peakBytesPerSecond: null, averageBytesPerSecond: null };
  }
  const firstByte = counts.find(count => count.total > 0);
  let peak: number | null = null;
  for (const [index, count] of counts.entries()) {
    const previous = counts[index - 1];
    const rate = previous === undefined ? null : getByteRate(previous, count);
    if (rate !== null) {
      peak = Math.max(peak ?? 0, rate);
    }
  }
  return {
    totalBytes: last.total,
    firstByteMs: firstByte?.at ?? null,
    peakBytesPerSecond: peak,
    averageBytesPerSecond: getByteRate({ at: 0, total: 0 }, last),
  };
}

/** Bytes per second between two counts, or `null` when no time passed between them. */
function getByteRate(from: ByteCount, to: ByteCount): number | null {
  const seconds = (to.at - from.at) / 1000;
  return seconds > 0 ? (to.total - from.total) / seconds : null;
}

function toChainBackend(value: unknown): ResolutionSummary['backend'] {
  return value === 'smoldot' || value === 'rpc-gateway' ? value : null;
}

/** The summary's transport for a backend, or `null` for a backend this build does not know. */
function readTransport(value: unknown): ResolutionSummary['backend'] {
  const backend = parseBackend(readString(value));
  if (backend === null) {
    return null;
  }
  return hasLightClient(backend) ? 'smoldot' : 'rpc-gateway';
}

/** The field `name` of the payload of `event`, unchecked. */
function readField(event: DotliDebugEvent, name: string): unknown {
  const payload: Record<string, unknown> = event.payload;
  return payload[name];
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
