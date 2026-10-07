// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// One page load as a row of phase blocks per chain role, plus whole-load figures.
// Not shared with `resolution-trace.ts`, which samples loads and keeps only aggregates.

import { CHAIN_ROLE_LABELS, CHAIN_ROLES, type ChainRole } from '@dotli/config';
import type { DotliDebugEvent } from './dotli-debug-types.js';

/** `endMs` is null while the chain is still in the phase. */
export interface ResolutionBlock {
  phase: string;
  startMs: number;
  endMs: number | null;
  reason: string | null;
}

export interface ResolutionRow {
  role: ChainRole;
  label: string;
  blocks: ResolutionBlock[];
  peers: number | null;
  peersAtReady: number | null;
  /** For a chain that never reported `ready`. */
  peersMax: number | null;
  warpAt: number | null;
  warpTarget: number | null;
  dbCache: 'hit' | 'miss' | null;
}

export type CacheResult = 'hit' | 'miss' | 'skipped' | null;

export interface ResolutionSummary {
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
  avgBytesPerSecond: number | null;
  peakBytesPerSecond: number | null;
  firstByteMs: number | null;
  cidCache: CacheResult;
  archiveCache: CacheResult;
}

export interface ResolutionModel {
  flowId: string | null;
  startedAt: number;
  elapsedMs: number;
  rows: ResolutionRow[];
  summary: ResolutionSummary;
}

const KEPT_LAYERS = new Set(['boot', 'resolve', 'render', 'chain', 'sandbox', 'failover']);

/** Kept apart from the event store, whose ring buffer evicts a busy load's early phases first. */
export interface ResolutionRecorder {
  record(ev: DotliDebugEvent): void;
  clear(): void;
  /** Oldest first. The same array for the recorder's lifetime, trimmed in place, so do not keep it. */
  events(): readonly DotliDebugEvent[];
  version(): number;
}

const RECORDER_CAP = 4000;

export function createResolutionRecorder(): ResolutionRecorder {
  const kept: DotliDebugEvent[] = [];
  let version = 0;
  return {
    record(ev) {
      if (!KEPT_LAYERS.has(ev.layer)) {
        return;
      }
      kept.push(ev);
      // A slice would copy every retained event on each record once full.
      if (kept.length > RECORDER_CAP) {
        kept.shift();
      }
      version++;
    },
    clear() {
      kept.length = 0;
      version++;
    },
    events() {
      return kept;
    },
    version() {
      return version;
    },
  };
}

function payloadOf(ev: DotliDebugEvent): Record<string, unknown> {
  return ev.payload;
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Anchored on the newest `boot:started`, not one `flowId`, because boot, resolve and render each mint their own flow.
 */
export function buildResolution(events: readonly DotliDebugEvent[], now: number): ResolutionModel {
  let bootAt = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev?.layer === 'boot' && ev.event === 'started') {
      bootAt = i;
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
      summary: emptySummary(),
    };
  }
  const startedAt = first.timestamp;
  const endedAt = loadEnd(load, now);
  // Chains keep reporting after the app is on screen, so bound the window at the load's end.
  const mine = load.filter(e => e.timestamp <= endedAt);
  const summary = buildSummary(mine, startedAt);
  // A cached resolution emits no `resolve:completed`, so the product being on screen ends the load.
  if (summary.outcome === 'running' && isFinished(mine)) {
    summary.outcome = summary.cid === null ? 'empty' : 'resolved';
  }

  return {
    flowId: first.flowId,
    startedAt,
    elapsedMs: Math.max(0, endedAt - startedAt),
    rows: withLatestPeers(buildRows(mine, startedAt, endedAt), mine),
    summary,
  };
}

/** Peers arrive a beat after the phases, so any peer event inside the window counts. */
function withLatestPeers(rows: ResolutionRow[], load: readonly DotliDebugEvent[]): ResolutionRow[] {
  const best = new Map<string, number>();
  for (const ev of load) {
    if (ev.layer !== 'chain' || ev.event !== 'peers') {
      continue;
    }
    const p = payloadOf(ev);
    const chain = str(p['chain']);
    const peers = num(p['peers']);
    if (chain === null || peers === null) {
      continue;
    }
    best.set(chain, Math.max(best.get(chain) ?? 0, peers));
  }
  for (const row of rows) {
    const seen = best.get(row.role);
    if (seen !== undefined) {
      row.peers = Math.max(row.peers ?? 0, seen);
    }
  }
  return rows;
}

function isFinished(mine: readonly DotliDebugEvent[]): boolean {
  return mine.some(
    ev =>
      (ev.layer === 'render' && ev.event === 'iframe_ready') ||
      (ev.layer === 'boot' && (ev.event === 'ready' || ev.event === 'failed')) ||
      (ev.layer === 'resolve' && (ev.event === 'completed' || ev.event === 'failed')),
  );
}

function loadEnd(load: readonly DotliDebugEvent[], now: number): number {
  let last = 0;
  let lastChainPhase = 0;
  let lastSandbox = 0;
  for (const ev of load) {
    if (
      (ev.layer === 'render' && ev.event === 'iframe_ready') ||
      (ev.layer === 'boot' && (ev.event === 'ready' || ev.event === 'failed')) ||
      (ev.layer === 'resolve' && (ev.event === 'completed' || ev.event === 'failed'))
    ) {
      last = Math.max(last, ev.timestamp);
    }
    if (ev.layer === 'chain' && ev.event === 'phase') {
      lastChainPhase = Math.max(lastChainPhase, ev.timestamp);
    }
    if (ev.layer === 'sandbox') {
      lastSandbox = Math.max(lastSandbox, ev.timestamp);
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

const LOAD_END_GRACE_MS = 30_000;

function buildRows(mine: readonly DotliDebugEvent[], startedAt: number, endedAt: number): ResolutionRow[] {
  const byRole = new Map<ChainRole, ResolutionRow>();
  for (const role of CHAIN_ROLES) {
    byRole.set(role, {
      role,
      label: CHAIN_ROLE_LABELS[role],
      blocks: [],
      peers: null,
      peersAtReady: null,
      peersMax: null,
      warpAt: null,
      warpTarget: null,
      dbCache: null,
    });
  }

  for (const ev of mine) {
    if (ev.layer !== 'chain') {
      continue;
    }
    if (ev.event !== 'phase' && ev.event !== 'peers' && ev.event !== 'dbcache') {
      continue;
    }
    const p = payloadOf(ev);
    const role = CHAIN_ROLES.find(r => r === str(p['chain']));
    const row = role === undefined ? undefined : byRole.get(role);
    if (row === undefined) {
      continue;
    }
    if (ev.event === 'dbcache') {
      const cache = str(p['dbCache']);
      if (cache === 'hit' || cache === 'miss') {
        // First answer wins, matching the resolver-side latch.
        row.dbCache ??= cache;
      }
      continue;
    }
    if (ev.event === 'peers') {
      // A peer change never opens a block of its own.
      const open = row.blocks.length === 0 ? null : row.blocks[row.blocks.length - 1];
      notePeers(row, num(p['peers']), open?.phase ?? 'unknown');
      continue;
    }
    const phase = str(p['phase']) ?? 'unknown';
    const at = Math.max(0, ev.timestamp - startedAt);
    const previous = row.blocks.at(-1);
    if (previous !== undefined) {
      previous.endMs = at;
      if (previous.phase === phase) {
        // A warp update within the same phase keeps the block running instead of splitting it.
        previous.endMs = null;
        notePeers(row, num(p['peers']), phase);
        row.warpAt = num(p['warpAt']) ?? row.warpAt;
        row.warpTarget = num(p['warpTarget']) ?? row.warpTarget;
        continue;
      }
    }
    row.blocks.push({
      phase,
      startMs: at,
      endMs: null,
      reason: str(p['reason']),
    });
    notePeers(row, num(p['peers']), phase);
    row.warpAt = num(p['warpAt']) ?? row.warpAt;
    row.warpTarget = num(p['warpTarget']) ?? row.warpTarget;
  }

  for (const row of byRole.values()) {
    // A chain that went ready with peers and later dropped them was not a zero-peer chain for this load.
    row.peers = row.peersAtReady ?? row.peersMax ?? row.peers;
  }

  const span = Math.max(0, endedAt - startedAt);
  for (const row of byRole.values()) {
    const last = row.blocks.at(-1);
    if (last === undefined) {
      continue;
    }
    last.endMs ??= Math.max(last.startMs, span);
  }
  return CHAIN_ROLES.map(role => byRole.get(role)).filter((row): row is ResolutionRow => row !== undefined);
}

function notePeers(row: ResolutionRow, peers: number | null, phase: string): void {
  if (peers === null) {
    return;
  }
  row.peers = peers;
  row.peersMax = Math.max(row.peersMax ?? 0, peers);
  if (phase === 'ready') {
    // Best seen, not newest: a chain reports `ready` with no peers and gains them a moment later.
    row.peersAtReady = Math.max(row.peersAtReady ?? 0, peers);
  }
}

function emptySummary(): ResolutionSummary {
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
    avgBytesPerSecond: null,
    peakBytesPerSecond: null,
    firstByteMs: null,
    cidCache: null,
    archiveCache: null,
  };
}

function buildSummary(mine: readonly DotliDebugEvent[], startedAt: number): ResolutionSummary {
  const summary = emptySummary();

  let previousBytes: { at: number; total: number } | null = null;
  // The sandbox writing its document is the real paint. `render:iframe_ready` is only the frame attach.
  let paintedMs: number | null = null;

  for (const ev of mine) {
    const p = payloadOf(ev);
    const key = `${ev.layer}:${ev.event}`;
    switch (key) {
      case 'resolve:started': {
        const source = str(p['source']);
        if (source === 'smoldot' || source === 'rpc-gateway') {
          summary.backend = source;
        }
        summary.label = str(p['label']) ?? summary.label;
        break;
      }
      case 'resolve:completed': {
        const source = str(p['source']);
        if (source === 'smoldot' || source === 'rpc-gateway') {
          summary.backend = source;
        }
        summary.label = str(p['label']) ?? summary.label;
        summary.cid = str(p['cid']);
        summary.resolveMs = num(p['durationMs']);
        summary.outcome = summary.cid === null ? 'empty' : 'resolved';
        break;
      }
      case 'resolve:failed':
        summary.outcome = 'failed';
        summary.failureReason = str(p['reason']);
        summary.label = str(p['label']) ?? summary.label;
        break;
      case 'boot:failed':
        summary.outcome = 'failed';
        summary.failureReason = str(p['reason']);
        break;
      case 'render:iframe_ready':
        summary.renderedMs = Math.max(0, ev.timestamp - startedAt);
        break;
      case 'boot:ready':
        // Fallback for a load whose render event never reached the recorder.
        summary.renderedMs ??= Math.max(0, ev.timestamp - startedAt);
        break;
      case 'boot:started': {
        // Authoritative, because a load served from the CID cache emits no resolve event.
        const backend = str(p['chainBackend']);
        if (backend === 'rpc-gateway') {
          summary.backend = 'rpc-gateway';
        } else if (backend?.startsWith('smoldot') === true) {
          summary.backend = 'smoldot';
        }
        // A cache the user turned off never reports a result.
        if (p['skipCidCache'] === true) {
          summary.cidCache = 'skipped';
        }
        if (p['skipArchiveCache'] === true) {
          summary.archiveCache = 'skipped';
        }
        break;
      }
      case 'boot:cid_cache_checked':
        summary.cidCache = p['hit'] === true ? 'hit' : 'miss';
        // A cache hit resolves the name without a `resolve:completed` event.
        if (p['hit'] === true) {
          summary.cid ??= str(p['cid']);
          summary.label ??= str(p['label']);
          summary.resolveMs ??= Math.max(0, ev.timestamp - startedAt);
        }
        break;
      case 'boot:block_cache':
        summary.archiveCache = num(p['misses']) === 0 && (num(p['hits']) ?? 0) > 0 ? 'hit' : 'miss';
        break;
      case 'sandbox:document_written':
        summary.appBytes = num(p['bytes']);
        summary.appFileCount = num(p['fileCount']);
        paintedMs = Math.max(0, ev.timestamp - startedAt);
        break;
      case 'failover:chain_backend': {
        const to = str(p['to']);
        if (to === 'smoldot' || to === 'rpc-gateway') {
          summary.backend = to;
        }
        break;
      }
      case 'chain:bytes': {
        const total = num(p['received']);
        if (total === null) {
          break;
        }
        summary.totalBytes = total;
        if (summary.firstByteMs === null && total > 0) {
          summary.firstByteMs = Math.max(0, ev.timestamp - startedAt);
        }
        if (previousBytes !== null) {
          const seconds = (ev.timestamp - previousBytes.at) / 1000;
          if (seconds > 0) {
            const rate = (total - previousBytes.total) / seconds;
            summary.peakBytesPerSecond = Math.max(summary.peakBytesPerSecond ?? 0, rate);
          }
        }
        previousBytes = { at: ev.timestamp, total };
        break;
      }
      default:
        break;
    }
  }

  summary.renderedMs = paintedMs ?? summary.renderedMs;
  if (summary.totalBytes !== null && previousBytes !== null) {
    const seconds = (previousBytes.at - startedAt) / 1000;
    if (seconds > 0) {
      summary.avgBytesPerSecond = summary.totalBytes / seconds;
    }
  }
  return summary;
}
