// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Resolution view: the recorder and the model
//
// One page load drawn as four rows, one per chain: Relay, Hub, Identity and
// Storage. Each row is a run of blocks, one block per lifecycle phase the
// chain passed through, block width proportional to the time spent in it. Above them, the figures that
// describe the load as a whole: what it resolved, how fast the link was, and
// which caches answered.
//
// Distinct from the Timeline view, which is event-shaped and swimlaned by
// genesis hash. This one is state-shaped and keyed by chain role, so the
// question it answers is "where did the time go", not "what was said".
//
// The model is built from the debug events alone, and deliberately not shared
// with `resolution-trace.ts`: that one samples a fraction of loads and keeps
// only aggregates, where a debug panel has to show every load in full.

import { CHAIN_ROLE_LABELS, CHAIN_ROLES, type ChainRole } from '@dotli/config';
import type { DotliDebugEvent } from './dotli-debug-types.js';

/** One phase a chain sat in. `endMs` is null while it is still sitting there. */
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
  /** The count when the chain became usable, which is what the row shows. */
  peersAtReady: number | null;
  /** Best seen, for a chain that never reported a `ready` phase. */
  peersMax: number | null;
  warpAt: number | null;
  warpTarget: number | null;
  /** Whether the light client resumed this chain from its stored database. */
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
  executableCache: CacheResult;
  archiveCache: CacheResult;
}

export interface ResolutionModel {
  flowId: string | null;
  startedAt: number;
  elapsedMs: number;
  rows: ResolutionRow[];
  summary: ResolutionSummary;
}

/** Layers the view reads. Everything else belongs to the Timeline. */
const KEPT_LAYERS = new Set(['boot', 'resolve', 'render', 'chain', 'sandbox', 'failover']);

/**
 * Retained copy of the events the view needs.
 *
 * The event store is a ring buffer, so on a busy session the early phase
 * transitions of the load being looked at are the first thing evicted.
 * Silently losing the head of every row is worse than not drawing it. The
 * kept layers are a small fraction of the traffic (TrUAPI wire frames are the
 * bulk of it), so retaining them separately costs little.
 */
export interface ResolutionRecorder {
  record(ev: DotliDebugEvent): void;
  clear(): void;
  /** Oldest first. The same array for the recorder's lifetime, trimmed in
   *  place: read it, do not keep it. */
  events(): readonly DotliDebugEvent[];
  /** Bumped whenever `events()` changes, so a view can skip a rebuild. */
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
      // One at a time, as the event store does: a slice here would copy
      // every retained event on every record once full.
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
 * Build the model for the newest page load present in `events`.
 *
 * Anchored on the newest `boot:started` rather than on one `flowId`: the boot,
 * resolve and render layers each mint their own flow, so a single id covers
 * only part of a load. Everything recorded from that boot onward belongs to
 * it, because a page load is the lifetime of the realm this panel lives in.
 *
 * Pure: `now` is passed in so the open block of an in-flight load can be drawn to
 * the current moment without the builder reaching for a clock.
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
  // Chains keep reporting long after the app is on screen. Bounding the window
  // at the moment the load finished keeps this a picture of the resolution
  // rather than a chart that grows for as long as the tab stays open.
  const mine = load.filter(e => e.timestamp <= endedAt);
  const summary = buildSummary(mine, startedAt);
  // The product being on screen ends the load, whatever the resolve events
  // said. A resolution served from cache emits no `resolve:completed`, and a
  // recorder that started mid-load may not hold one. Without this the view
  // sits on "still running" for ever with its bars animating.
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

/**
 * Fill in the peer count of each row from the bounded load window.
 *
 * A chain reports its phases in the first moments and finds its peers a beat
 * later, so the count is taken from any peer event inside the window rather
 * than only the ones riding phase changes. Events after the window are the
 * network panel to report: this view freezes once the resolution is over.
 */
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

/** Whether anything in the window says the product reached the screen. */
function isFinished(mine: readonly DotliDebugEvent[]): boolean {
  return mine.some(
    ev =>
      (ev.layer === 'render' && ev.event === 'iframe_ready') ||
      (ev.layer === 'boot' && (ev.event === 'ready' || ev.event === 'failed')) ||
      (ev.layer === 'resolve' && (ev.event === 'completed' || ev.event === 'failed')),
  );
}

/**
 * Where the axis ends: the moment the product was on screen, or now while the
 * load is still in flight.
 */
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
  // The chains outlive the paint on a cached load. A CID-cache hit puts the
  // product on screen in ~50ms while every chain is still `connecting`, so
  // ending the window at the paint dropped every chain event and left four
  // empty rows. The sandbox reports its cache answer just after the paint for
  // the same reason. Both extensions are capped: a stall or a phase change
  // minutes later belongs to the network panel, not to this picture of the
  // resolution, and following it would grow the chart for as long as the tab
  // stays open.
  const grace = last + LOAD_END_GRACE_MS;
  return Math.max(last, Math.min(lastChainPhase, grace), Math.min(lastSandbox, grace));
}

// How long after the paint a chain phase or sandbox report may still extend
// the window. Long enough for a cached load to catch its chains going ready,
// short enough that the view settles and never moves again.
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
      // A peer change never opens a block of its own: the chain is still in
      // whatever phase it was already drawing.
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
        // A warp update: the chain never left the phase, so the block it is
        // already drawing simply keeps running rather than being cut in two.
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
    // Prefer the count at the moment the chain became usable. A chain that
    // goes ready with 4 peers and later drops to 0 is not a zero-peer chain
    // for the purposes of describing the load that just happened.
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

/** Records a peer sample against the phase it arrived in. */
function notePeers(row: ResolutionRow, peers: number | null, phase: string): void {
  if (peers === null) {
    return;
  }
  row.peers = peers;
  row.peersMax = Math.max(row.peersMax ?? 0, peers);
  if (phase === 'ready') {
    // Best seen while usable, not the newest. A chain reports `ready` with no
    // peers and gains them a moment later, and it also drops peers long after
    // the load finished. Neither should make the row read "0 peers".
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
    executableCache: null,
    archiveCache: null,
  };
}

function buildSummary(mine: readonly DotliDebugEvent[], startedAt: number): ResolutionSummary {
  const summary = emptySummary();

  let previousBytes: { at: number; total: number } | null = null;
  // The sandbox writing its document is the app actually on screen.
  // `render:iframe_ready` is only the frame attach, which on a cold load
  // lands seconds earlier, so the more honest mark wins at the end.
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
        // `??=` so the render event, which is the more precise mark, wins.
        summary.renderedMs ??= Math.max(0, ev.timestamp - startedAt);
        break;
      case 'boot:started': {
        // The authoritative backend for the load, even before resolution begins.
        const backend = str(p['chainBackend']);
        if (backend === 'rpc-gateway') {
          summary.backend = 'rpc-gateway';
        } else if (backend?.startsWith('smoldot') === true) {
          summary.backend = 'smoldot';
        }
        // A cache the user turned off never reports a result. Seed the fields
        // here so the panel says so instead of "not reported", which reads as
        // a missing instrumentation hook.
        if (p['skipCidCache'] === true) {
          summary.executableCache = 'skipped';
        }
        if (p['skipArchiveCache'] === true) {
          summary.archiveCache = 'skipped';
        }
        break;
      }
      case 'boot:installed_executable_cache_checked':
        summary.executableCache = p['hit'] === true ? 'hit' : 'miss';
        summary.label ??= str(p['label']);
        // A local hit still needs chain revalidation. Its contenthash is not
        // a resolved CID, and the lookup time is not the resolution latency.
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
