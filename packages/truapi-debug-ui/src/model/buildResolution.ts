// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// One page load as a row of phase blocks per chain role, plus whole-load figures.

import { CHAIN_ROLE_LABELS, CHAIN_ROLES, type ChainRole, hasLightClient, parseBackend } from '@dotli/config';
import type { DotliDebugEvent } from '@dotli/truapi-debug';
import { getSystemEventKey } from './getSystemEventKey.js';

/** `endMs` is null while the chain is still in the phase. */
export type ResolutionBlock = {
  phase: string;
  startMs: number;
  endMs: number | null;
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
  endedAt: number;
};

/** A running byte count at a moment, in ms. */
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
  const endedAt = findLoadEnd(load, now);
  // Chains keep reporting after the app is on screen, so bound the window at the load's end.
  const mine = load.filter(e => e.timestamp <= endedAt);
  return {
    flowId: first.flowId,
    startedAt,
    elapsedMs: Math.max(0, endedAt - startedAt),
    rows: buildRows({ events: mine, startedAt, endedAt }),
    summary: buildSummary(mine, startedAt),
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

function findLoadEnd(load: readonly DotliDebugEvent[], now: number): number {
  let last = 0;
  let lastChainPhase = 0;
  let lastSandbox = 0;
  for (const event of load) {
    if (isLoadEndEvent(event)) {
      last = Math.max(last, event.timestamp);
    }
    if (event.layer === 'chain' && event.event === 'phase') {
      lastChainPhase = Math.max(lastChainPhase, event.timestamp);
    }
    if (event.layer === 'sandbox') {
      lastSandbox = Math.max(lastSandbox, event.timestamp);
    }
  }
  if (last === 0) {
    return now;
  }
  // A cached load paints while every chain is still connecting and before the sandbox reports its cache
  // answer, so both may extend the window, capped so the chart settles.
  const grace = last + LOAD_END_GRACE_MS;
  return Math.max(last, Math.min(lastChainPhase, grace), Math.min(lastSandbox, grace));
}

function buildRows({ events, startedAt, endedAt }: BuildRowsParams): ResolutionRow[] {
  // Keyed by the chain name a payload carries, which may name no role.
  const byChain = new Map<string, ResolutionRow>();
  for (const role of CHAIN_ROLES) {
    byChain.set(role, {
      role,
      label: CHAIN_ROLE_LABELS[role],
      blocks: [],
      peers: null,
      warpAt: null,
      warpTarget: null,
      dbCache: null,
    });
  }

  for (const event of events) {
    if (event.layer !== 'chain') {
      continue;
    }
    const payload: Record<string, unknown> = event.payload;
    const row = byChain.get(readString(payload['chain']) ?? '');
    if (row === undefined) {
      continue;
    }
    const peers = readNumber(payload['peers']);
    if (peers !== null) {
      row.peers = Math.max(row.peers ?? 0, peers);
    }
    switch (event.event) {
      case 'bytes':
        // A byte count belongs to the whole load, not to a chain's row.
        continue;
      case 'dbcache': {
        const cache = readString(payload['dbCache']);
        if (cache === 'hit' || cache === 'miss') {
          // First answer wins, so a later report cannot change the load's cache result.
          row.dbCache ??= cache;
        }
        continue;
      }
      case 'peers':
        // A peer change never opens a block of its own.
        continue;
      case 'phase':
        break;
    }
    const phase = readString(payload['phase']) ?? 'unknown';
    const at = Math.max(0, event.timestamp - startedAt);
    const previous = row.blocks.at(-1);
    // A warp update within the same phase keeps the block running instead of splitting it.
    if (previous?.phase !== phase) {
      if (previous !== undefined) {
        previous.endMs = at;
      }
      row.blocks.push({
        phase,
        startMs: at,
        endMs: null,
        reason: readString(payload['reason']),
      });
    }
    row.warpAt = readNumber(payload['warpAt']) ?? row.warpAt;
    row.warpTarget = readNumber(payload['warpTarget']) ?? row.warpTarget;
  }

  const span = Math.max(0, endedAt - startedAt);
  for (const row of byChain.values()) {
    const last = row.blocks.at(-1);
    if (last !== undefined) {
      last.endMs ??= Math.max(last.startMs, span);
    }
  }
  // Filled in role order, so the rows come out in that order.
  return [...byChain.values()];
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

function buildSummary(mine: readonly DotliDebugEvent[], startedAt: number): ResolutionSummary {
  const summary = createEmptySummary();

  let previousBytes: ByteCount | null = null;
  // The sandbox writing its document is the real paint. `render:iframe_ready` is only the frame attach.
  let paintedMs: number | null = null;

  for (const event of mine) {
    const payload: Record<string, unknown> = event.payload;
    const key = getSystemEventKey(event);
    // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check -- only some events change a resolution, every other one changes nothing
    switch (key) {
      case 'resolve:started':
        summary.backend = toChainBackend(payload['source']) ?? summary.backend;
        summary.label = readString(payload['label']) ?? summary.label;
        break;
      case 'resolve:completed':
        summary.backend = toChainBackend(payload['source']) ?? summary.backend;
        summary.label = readString(payload['label']) ?? summary.label;
        summary.cid = readString(payload['cid']);
        summary.resolveMs = readNumber(payload['durationMs']);
        summary.outcome = summary.cid === null ? 'empty' : 'resolved';
        break;
      case 'resolve:failed':
        summary.outcome = 'failed';
        summary.failureReason = readString(payload['reason']);
        summary.label = readString(payload['label']) ?? summary.label;
        break;
      case 'boot:failed':
        summary.outcome = 'failed';
        summary.failureReason = readString(payload['reason']);
        break;
      case 'render:iframe_ready':
        summary.renderedMs = Math.max(0, event.timestamp - startedAt);
        break;
      case 'boot:ready':
        // Fallback for a load whose render event never reached the recorder.
        summary.renderedMs ??= Math.max(0, event.timestamp - startedAt);
        break;
      case 'boot:started': {
        // Authoritative, because a load served from the CID cache emits no resolve event.
        const backend = readString(payload['chainBackend']);
        if (backend === 'rpc-gateway') {
          summary.backend = 'rpc-gateway';
        } else if (backend?.startsWith('smoldot') === true) {
          summary.backend = 'smoldot';
        }
        // A cache the user turned off never reports a result.
        if (payload['skipCidCache'] === true) {
          summary.cidCache = 'skipped';
        }
        if (payload['skipArchiveCache'] === true) {
          summary.archiveCache = 'skipped';
        }
        break;
      }
      case 'boot:cid_cache_checked':
        summary.cidCache = payload['hit'] === true ? 'hit' : 'miss';
        // A cache hit resolves the name without a `resolve:completed` event.
        if (payload['hit'] === true) {
          summary.cid ??= readString(payload['cid']);
          summary.label ??= readString(payload['label']);
          summary.resolveMs ??= Math.max(0, event.timestamp - startedAt);
        }
        break;
      case 'boot:block_cache':
        summary.archiveCache =
          readNumber(payload['misses']) === 0 && (readNumber(payload['hits']) ?? 0) > 0 ? 'hit' : 'miss';
        break;
      case 'sandbox:document_written':
        summary.appBytes = readNumber(payload['bytes']);
        summary.appFileCount = readNumber(payload['fileCount']);
        paintedMs = Math.max(0, event.timestamp - startedAt);
        break;
      case 'failover:chain_backend':
        summary.backend = readFailoverBackend(payload['to']) ?? summary.backend;
        break;
      case 'chain:bytes': {
        const total = readNumber(payload['received']);
        if (total === null) {
          break;
        }
        summary.totalBytes = total;
        if (summary.firstByteMs === null && total > 0) {
          summary.firstByteMs = Math.max(0, event.timestamp - startedAt);
        }
        const current = { at: event.timestamp, total };
        const rate = previousBytes === null ? null : getByteRate(previousBytes, current);
        if (rate !== null) {
          summary.peakBytesPerSecond = Math.max(summary.peakBytesPerSecond ?? 0, rate);
        }
        previousBytes = current;
        break;
      }
      default:
        break;
    }
  }

  // A cached resolution emits no `resolve:completed`, so the product being on screen ends the load.
  if (summary.outcome === 'running' && mine.some(isLoadEndEvent)) {
    summary.outcome = summary.cid === null ? 'empty' : 'resolved';
  }
  summary.renderedMs = paintedMs ?? summary.renderedMs;
  if (previousBytes !== null) {
    summary.averageBytesPerSecond = getByteRate({ at: startedAt, total: 0 }, previousBytes);
  }
  return summary;
}

/** Bytes per second between two counts, or `null` when no time passed between them. */
function getByteRate(from: ByteCount, to: ByteCount): number | null {
  const seconds = (to.at - from.at) / 1000;
  return seconds > 0 ? (to.total - from.total) / seconds : null;
}

function toChainBackend(value: unknown): ResolutionSummary['backend'] {
  return value === 'smoldot' || value === 'rpc-gateway' ? value : null;
}

/** The summary's transport for a failover target, or `null` for a backend this build does not know. */
function readFailoverBackend(value: unknown): ResolutionSummary['backend'] {
  const backend = parseBackend(readString(value));
  if (backend === null) {
    return null;
  }
  return hasLightClient(backend) ? 'smoldot' : 'rpc-gateway';
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
