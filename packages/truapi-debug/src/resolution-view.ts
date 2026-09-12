// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Resolution view
//
// One page load drawn as four rows, one per chain: Relay, Hub, Identity and
// Storage. Each row is a run of blocks, one block per lifecycle phase the
// chain passed through, block width proportional to the time spent in it. Above them, the figures that
// describe the load as a whole: what it resolved, how fast the link was, and
// which caches answered.
//
// Distinct from the Timeline view, which is event-shaped and swimlaned by
// genesis hash. This one is state-shaped and keyed by the chain's role, so the
// question it answers is "where did the time go", not "what was said".
//
// The model is built from the debug events alone, and deliberately not shared
// with `resolution-trace.ts`: that one samples a fraction of loads and keeps
// only aggregates, where a debug panel has to show every load in full.

import { escapeHtml } from "@dotli/shared/html";
import {
  CHAIN_ROLE_LABELS,
  CHAIN_ROLES,
  type ChainRole,
} from "@dotli/config/network";
import type { DotliDebugEvent } from "./dotli-debug-types.ts";

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
}

export type CacheResult = "hit" | "miss" | "skipped" | null;

export interface ResolutionSummary {
  backend: "smoldot" | "rpc-gateway" | null;
  outcome: "running" | "resolved" | "empty" | "failed";
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

/** Layers the view reads. Everything else is the Timeline's business. */
const KEPT_LAYERS = new Set([
  "boot",
  "resolve",
  "render",
  "chain",
  "sandbox",
  "failover",
]);

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
  events(): readonly DotliDebugEvent[];
}

const RECORDER_CAP = 4000;

export function createResolutionRecorder(): ResolutionRecorder {
  let kept: DotliDebugEvent[] = [];
  return {
    record(ev) {
      if (!KEPT_LAYERS.has(ev.layer)) {
        return;
      }
      kept.push(ev);
      if (kept.length > RECORDER_CAP) {
        kept = kept.slice(kept.length - RECORDER_CAP);
      }
    },
    clear() {
      kept = [];
    },
    events() {
      return kept;
    },
  };
}

/** Phases with a colour of their own; anything else falls back to neutral. */
const PHASE_CLASSES = new Set(["connecting", "syncing", "ready", "stalled"]);

function payloadOf(ev: DotliDebugEvent): Record<string, unknown> {
  return ev.payload;
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Build the model for the newest page load present in `events`.
 *
 * Anchored on the newest `boot:started` rather than on one `flowId`: the boot,
 * resolve and render layers each mint their own flow, so a single id covers
 * only part of a load. Everything recorded from that boot onward belongs to
 * it, because a page load is the lifetime of this panel's own realm.
 *
 * Pure: `now` is passed in so an in-flight load's open block can be drawn to
 * the current moment without the builder reaching for a clock.
 */
export function buildResolution(
  events: readonly DotliDebugEvent[],
  now: number,
): ResolutionModel {
  let bootAt = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].layer === "boot" && events[i].event === "started") {
      bootAt = i;
      break;
    }
  }
  const load = bootAt === -1 ? events : events.slice(bootAt);
  if (load.length === 0) {
    return {
      flowId: null,
      startedAt: now,
      elapsedMs: 0,
      rows: [],
      summary: emptySummary(),
    };
  }
  const startedAt = load[0].timestamp;
  const endedAt = loadEnd(load, now);
  // Chains keep reporting long after the app is on screen. Bounding the window
  // at the moment the load finished keeps this a picture of the resolution
  // rather than a chart that grows for as long as the tab stays open.
  const mine = load.filter((e) => e.timestamp <= endedAt);
  const summary = buildSummary(mine, startedAt);
  // The product being on screen ends the load, whatever the resolve events
  // said. A resolution served from cache emits no `resolve:completed`, and a
  // recorder that started mid-load may not hold one. Without this the view
  // sits on "still running" for ever with its bars animating.
  if (summary.outcome === "running" && isFinished(mine)) {
    summary.outcome = summary.cid === null ? "empty" : "resolved";
  }

  return {
    flowId: load[0].flowId,
    startedAt,
    elapsedMs: Math.max(0, endedAt - startedAt),
    rows: withLatestPeers(buildRows(mine, startedAt, endedAt), load),
    summary,
  };
}

/**
 * Fill in each row's peer count from the whole load, not just the drawing
 * window.
 *
 * A chain reports its phases in the first moments and finds its peers a beat
 * later, often after the last phase change that bounds the chart. Reading the
 * count off the window alone showed "0 peers" for a chain that plainly had
 * some. Only the number is taken from outside the window. The blocks, and so
 * everything that moves, stay bounded by it.
 */
function withLatestPeers(
  rows: ResolutionRow[],
  load: readonly DotliDebugEvent[],
): ResolutionRow[] {
  const best = new Map<string, number>();
  for (const ev of load) {
    if (ev.layer !== "chain" || ev.event !== "peers") {
      continue;
    }
    const p = payloadOf(ev);
    const chain = str(p.chain);
    const peers = num(p.peers);
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
    (ev) =>
      (ev.layer === "render" && ev.event === "iframe_ready") ||
      (ev.layer === "boot" &&
        (ev.event === "ready" || ev.event === "failed")) ||
      (ev.layer === "resolve" &&
        (ev.event === "completed" || ev.event === "failed")),
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
      (ev.layer === "render" && ev.event === "iframe_ready") ||
      (ev.layer === "boot" &&
        (ev.event === "ready" || ev.event === "failed")) ||
      (ev.layer === "resolve" &&
        (ev.event === "completed" || ev.event === "failed"))
    ) {
      last = Math.max(last, ev.timestamp);
    }
    if (ev.layer === "chain" && ev.event === "phase") {
      lastChainPhase = Math.max(lastChainPhase, ev.timestamp);
    }
    if (ev.layer === "sandbox") {
      lastSandbox = Math.max(lastSandbox, ev.timestamp);
    }
  }
  if (last === 0) {
    return now;
  }
  // The chains outlive the paint on a cached load. A CID-cache hit puts the
  // product on screen in ~50ms while every chain is still `connecting`, so
  // ending the window at the paint dropped every chain event and left four
  // empty rows. Phases stop once each chain is ready, so following them does
  // not make the chart grow for as long as the tab is open.
  //
  // The sandbox starts working only once the iframe exists, so every event it
  // reports lands after `render:iframe_ready`. Without following it the archive
  // cache result falls outside the window and the summary reads "not reported"
  // for a lookup that plainly happened. Bounded for the same reason as the
  // phases: the sandbox reports during its boot and then hands over to the dApp.
  return Math.max(last, lastChainPhase, lastSandbox);
}

function buildRows(
  mine: readonly DotliDebugEvent[],
  startedAt: number,
  endedAt: number,
): ResolutionRow[] {
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
    });
  }

  for (const ev of mine) {
    if (ev.layer !== "chain") {
      continue;
    }
    if (ev.event !== "phase" && ev.event !== "peers") {
      continue;
    }
    const p = payloadOf(ev);
    const role = CHAIN_ROLES.find((r) => r === str(p.chain));
    const row = role === undefined ? undefined : byRole.get(role);
    if (row === undefined) {
      continue;
    }
    if (ev.event === "peers") {
      // A peer change never opens a block of its own: the chain is still in
      // whatever phase it was already drawing.
      const open =
        row.blocks.length === 0 ? null : row.blocks[row.blocks.length - 1];
      notePeers(row, num(p.peers), open?.phase ?? "unknown");
      continue;
    }
    const phase = str(p.phase) ?? "unknown";
    const at = Math.max(0, ev.timestamp - startedAt);
    const previous =
      row.blocks.length === 0 ? null : row.blocks[row.blocks.length - 1];
    if (previous !== null) {
      previous.endMs = at;
      if (previous.phase === phase) {
        // A warp update: the chain never left the phase, so the block it is
        // already drawing simply keeps running rather than being cut in two.
        previous.endMs = null;
        notePeers(row, num(p.peers), phase);
        row.warpAt = num(p.warpAt) ?? row.warpAt;
        row.warpTarget = num(p.warpTarget) ?? row.warpTarget;
        continue;
      }
    }
    row.blocks.push({
      phase,
      startMs: at,
      endMs: null,
      reason: str(p.reason),
    });
    notePeers(row, num(p.peers), phase);
    row.warpAt = num(p.warpAt) ?? row.warpAt;
    row.warpTarget = num(p.warpTarget) ?? row.warpTarget;
  }

  for (const row of byRole.values()) {
    // Prefer the count at the moment the chain became usable. A chain that
    // goes ready with 4 peers and later drops to 0 is not a zero-peer chain
    // for the purposes of describing the load that just happened.
    row.peers = row.peersAtReady ?? row.peersMax ?? row.peers;
  }

  const span = Math.max(0, endedAt - startedAt);
  for (const row of byRole.values()) {
    if (row.blocks.length === 0) {
      continue;
    }
    const last = row.blocks[row.blocks.length - 1];
    last.endMs ??= Math.max(last.startMs, span);
  }
  return CHAIN_ROLES.map((role) => byRole.get(role)).filter(
    (row): row is ResolutionRow => row !== undefined,
  );
}

/** Records a peer sample against the phase it arrived in. */
function notePeers(
  row: ResolutionRow,
  peers: number | null,
  phase: string,
): void {
  if (peers === null) {
    return;
  }
  row.peers = peers;
  row.peersMax = Math.max(row.peersMax ?? 0, peers);
  if (phase === "ready") {
    // Best seen while usable, not the newest. A chain reports `ready` with no
    // peers and gains them a moment later, and it also drops peers long after
    // the load finished. Neither should make the row read "0 peers".
    row.peersAtReady = Math.max(row.peersAtReady ?? 0, peers);
  }
}

function emptySummary(): ResolutionSummary {
  return {
    backend: null,
    outcome: "running",
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

function buildSummary(
  mine: readonly DotliDebugEvent[],
  startedAt: number,
): ResolutionSummary {
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
      case "resolve:started": {
        const source = str(p.source);
        if (source === "smoldot" || source === "rpc-gateway") {
          summary.backend = source;
        }
        summary.label = str(p.label) ?? summary.label;
        break;
      }
      case "resolve:completed": {
        const source = str(p.source);
        if (source === "smoldot" || source === "rpc-gateway") {
          summary.backend = source;
        }
        summary.label = str(p.label) ?? summary.label;
        summary.cid = str(p.cid);
        summary.resolveMs = num(p.durationMs);
        summary.outcome = summary.cid === null ? "empty" : "resolved";
        break;
      }
      case "resolve:failed":
        summary.outcome = "failed";
        summary.failureReason = str(p.reason);
        summary.label = str(p.label) ?? summary.label;
        break;
      case "boot:failed":
        summary.outcome = "failed";
        summary.failureReason = str(p.reason);
        break;
      case "render:iframe_ready":
        summary.renderedMs = Math.max(0, ev.timestamp - startedAt);
        break;
      case "boot:ready":
        // Fallback for a load whose render event never reached the recorder.
        // `??=` so the render event, which is the more precise mark, wins.
        summary.renderedMs ??= Math.max(0, ev.timestamp - startedAt);
        break;
      case "boot:started": {
        // The authoritative backend for the load. `resolve:started` also
        // carries one, but a load served from the CID cache never emits a
        // resolve event at all, and without this the gateway rows rendered as
        // four chains that "never started" when no light client had ever run.
        const backend = str(p.chainBackend);
        if (backend === "rpc-gateway") {
          summary.backend = "rpc-gateway";
        } else if (backend?.startsWith("smoldot") === true) {
          summary.backend = "smoldot";
        }
        // A cache the user turned off never reports a result. Seed the fields
        // here so the panel says so instead of "not reported", which reads as
        // a missing instrumentation hook.
        if (p.skipCidCache === true) {
          summary.cidCache = "skipped";
        }
        if (p.skipArchiveCache === true) {
          summary.archiveCache = "skipped";
        }
        break;
      }
      case "boot:cid_cache_checked":
        summary.cidCache = p.hit === true ? "hit" : "miss";
        // A cache hit resolves the name without a `resolve:completed` event.
        // `??=` so a later real resolve still wins if both somehow appear.
        if (p.hit === true) {
          summary.cid ??= str(p.cid);
          summary.label ??= str(p.label);
          // The moment the CID was known, which is what "resolved in" means on
          // this path. Without it the field read "—" beside outcome "resolved".
          summary.resolveMs ??= Math.max(0, ev.timestamp - startedAt);
        }
        break;
      case "sandbox:document_written":
        summary.appBytes = num(p.bytes);
        summary.appFileCount = num(p.fileCount);
        paintedMs = Math.max(0, ev.timestamp - startedAt);
        break;
      case "sandbox:cache_checked":
        summary.archiveCache = p.hit === true ? "hit" : "miss";
        break;
      case "failover:chain_backend": {
        const to = str(p.to);
        if (to === "smoldot" || to === "rpc-gateway") {
          summary.backend = to;
        }
        break;
      }
      case "chain:bytes": {
        const total = num(p.received);
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
            summary.peakBytesPerSecond = Math.max(
              summary.peakBytesPerSecond ?? 0,
              rate,
            );
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

export function buildResolutionContainer(): { container: HTMLDivElement } {
  const container = document.createElement("div");
  container.className = "td-res";
  return { container };
}

/** How many labels the time axis carries. */
const AXIS_TICKS = 5;

export function renderResolution(
  container: HTMLDivElement,
  model: ResolutionModel,
): void {
  if (model.flowId === null) {
    container.innerHTML = `<div class="td-res-empty">No page load recorded yet. Reload the page with the panel open.</div>`;
    return;
  }
  container.innerHTML = `${renderSummary(model)}${renderChart(model)}`;
}

/**
 * One KPI card. `hint` is the plain-English explanation shown on hover, which is
 * the only place several of these are disambiguated: `sync download` counts
 * chain traffic and `app size` counts the dApp's files, and nothing else on
 * screen says so.
 */
interface Fact {
  key: string;
  /** Plain text. Escaped at render, so a producer never has to remember. */
  value: string;
  /** Markup, for the few facts that carry a styled span. Wins over `value`. */
  valueHtml?: string;
  hint: string;
}

/** Starts the next group on its own row. */
const GROUP_BREAK: Fact = { key: "", value: "", hint: "" };

function summaryFacts(model: ResolutionModel): Fact[] {
  const s = model.summary;
  return [
    {
      key: "name",
      value: s.label ?? "—",
      hint: "The .dot name this page load resolved.",
    },
    {
      key: "outcome",
      value: "",
      valueHtml: outcomeText(s),
      hint: "How far the load got. \u201cResolved\u201d means a content id was found for the name. On its own that does not mean the app rendered \u2014 read \u201capp on screen\u201d for that.",
    },
    {
      key: "network transport",
      value: "",
      valueHtml: transportText(s),
      hint: "How this load reached the chain. The smoldot light client verifies blocks itself; the RPC gateway trusts a remote node to answer honestly.",
    },
    GROUP_BREAK,
    {
      key: "elapsed",
      value: formatMs(model.elapsedMs),
      hint: "Wall clock for the whole load, from the host starting up to the app being on screen.",
    },
    {
      key: "resolved in",
      value: s.resolveMs === null ? "—" : formatMs(s.resolveMs),
      hint: "How long it took to turn the name into a content id. On a cache hit this is the moment the stored id was read, not a chain lookup.",
    },
    {
      key: "app on screen",
      value: s.renderedMs === null ? "—" : formatMs(s.renderedMs),
      hint: "When the sandbox wrote the app's document. This is the app actually visible, not the iframe being created, which happens seconds earlier on a cold load.",
    },
    {
      key: "first byte",
      value: s.firstByteMs === null ? "—" : formatMs(s.firstByteMs),
      hint: "Roughly when data first moved. The byte counter is only sampled about once a second, so treat this as an upper bound. Everything before it is finding peers and opening connections.",
    },
    GROUP_BREAK,
    {
      key: "sync download",
      value: s.totalBytes === null ? "—" : formatBytes(s.totalBytes),
      hint: "Every byte the light client pulled off the network, counted from boot until the app's frame was attached. Warp syncing the relay dominates a cold start. The app's own download rides the same connections but mostly arrives after this stops counting, so it is largely absent here.",
    },
    {
      key: "app size",
      value: appSizeText(s),
      hint: "How big the app is once unpacked, and how many files it came in. Fetched over the light client's own connections, or read straight from the archive cache.",
    },
    {
      key: "average speed",
      value: formatRate(s.avgBytesPerSecond),
      hint: "Sync download over the time it took to arrive. It includes the wait before any data moved, so it reads lower than your actual link speed.",
    },
    {
      key: "peak speed",
      value: formatRate(s.peakBytesPerSecond),
      hint: "The best rate seen between two byte samples, which are about a second apart. That makes it a one-second average, not a true instantaneous peak.",
    },
    GROUP_BREAK,
    {
      key: "CID cache",
      value: "",
      valueHtml: cacheText(s.cidCache),
      hint: "Whether this name's content id was already saved from an earlier visit, letting the load skip the chain lookup entirely. \u201cSkipped\u201d means the cache is turned off in settings.",
    },
    {
      key: "archive cache",
      value: "",
      valueHtml: cacheText(s.archiveCache),
      hint: "Whether the app's files were already in the service worker's cache, so nothing had to be fetched. \u201cSkipped\u201d means the cache is turned off in settings.",
    },
  ];
}

function renderSummary(model: ResolutionModel): string {
  const cards = summaryFacts(model)
    .map((fact) =>
      fact === GROUP_BREAK
        ? `<div class="td-res-group-break"></div>`
        : `<div class="td-res-fact"><dt>${escapeHtml(fact.key)}` +
          `<span class="td-res-info" data-tooltip="${escapeHtml(fact.hint)}" data-tooltip-prose aria-hidden="true">i</span>` +
          `</dt><dd>${fact.valueHtml ?? escapeHtml(fact.value)}</dd></div>`,
    )
    .join("");
  return `<dl class="td-res-summary">${cards}</dl>`;
}

function outcomeText(s: ResolutionSummary): string {
  switch (s.outcome) {
    case "running":
      return `<span class="td-res-outcome is-running">still running</span>`;
    case "resolved":
      return `<span class="td-res-outcome is-ok">resolved</span>`;
    case "empty":
      return `<span class="td-res-outcome is-warn">no content set</span>`;
    case "failed":
      return `<span class="td-res-outcome is-bad" data-tooltip="${escapeHtml(s.failureReason ?? "no reason reported")}" data-tooltip-prose>failed</span>`;
  }
}

function transportText(s: ResolutionSummary): string {
  switch (s.backend) {
    case "smoldot":
      return "smoldot light client";
    case "rpc-gateway":
      return "RPC gateway";
    case null:
      return `<span class="td-res-dim">not reported</span>`;
  }
}

function appSizeText(s: ResolutionSummary): string {
  if (s.appBytes === null) {
    return "—";
  }
  const files = s.appFileCount;
  if (files === null) {
    return formatBytes(s.appBytes);
  }
  return `${formatBytes(s.appBytes)} in ${String(files)} file${files === 1 ? "" : "s"}`;
}

function cacheText(result: CacheResult): string {
  if (result === null) {
    return `<span class="td-res-dim">not reported</span>`;
  }
  if (result === "hit") {
    return `<span class="td-res-outcome is-ok">hit</span>`;
  }
  if (result === "skipped") {
    return `<span class="td-res-dim">skipped (turned off)</span>`;
  }
  return `<span class="td-res-dim">miss</span>`;
}

function renderChart(model: ResolutionModel): string {
  if (model.summary.backend === "rpc-gateway") {
    return "";
  }
  const span = Math.max(1, model.elapsedMs);
  const axis = Array.from({ length: AXIS_TICKS + 1 }, (_, i) => {
    const at = (span * i) / AXIS_TICKS;
    const pct = (i / AXIS_TICKS) * 100;
    return `<span class="td-res-tick" style="left:${pct.toFixed(3)}%">${formatMs(at)}</span>`;
  }).join("");

  const rows = model.rows
    .map((row) => renderRow(row, span, model.summary.outcome === "running"))
    .join("");

  return (
    `<div class="td-res-chart">` +
    `<div class="td-res-row td-res-axis-row"><span class="td-res-name"></span><div class="td-res-track td-res-axis">${axis}</div><span class="td-res-meta"></span></div>` +
    rows +
    `</div>`
  );
}

function renderRow(row: ResolutionRow, span: number, running: boolean): string {
  const name = `<span class="td-res-name">${escapeHtml(row.label)}</span>`;
  if (row.blocks.length === 0) {
    return (
      `<div class="td-res-row">${name}` +
      `<div class="td-res-track"><span class="td-res-idle">never started. This chain was not needed, or the load ended first</span></div>` +
      `<span class="td-res-meta"></span></div>`
    );
  }
  const last = row.blocks.length - 1;
  const blocks = row.blocks
    .map((b, i) => {
      const end = b.endMs ?? span;
      const left = (b.startMs / span) * 100;
      const width = Math.max(0.4, ((end - b.startMs) / span) * 100);
      const open = running && i === last;
      const title = [
        `${b.phase} for ${formatMs(end - b.startMs)}`,
        `from ${formatMs(b.startMs)} to ${open ? "now" : formatMs(end)}`,
        b.reason,
      ]
        .filter((line): line is string => line !== null)
        .join("\n");
      return (
        `<div class="td-res-block is-${escapeHtml(phaseClass(b.phase))}${open ? " is-open" : ""}"` +
        ` style="left:${left.toFixed(3)}%;width:${width.toFixed(3)}%"` +
        ` title="${escapeHtml(title)}">` +
        `<span class="td-res-block-label">${escapeHtml(b.phase)}</span></div>`
      );
    })
    .join("");
  return (
    `<div class="td-res-row">${name}` +
    `<div class="td-res-track">${blocks}</div>` +
    `<span class="td-res-meta">${escapeHtml(rowMeta(row))}</span></div>`
  );
}

function rowMeta(row: ResolutionRow): string {
  const parts: string[] = [];
  if (row.peers !== null) {
    parts.push(`${String(row.peers)} peer${row.peers === 1 ? "" : "s"}`);
  }
  if (row.warpAt !== null && row.warpTarget !== null) {
    parts.push(`warped to ${String(row.warpAt)} of ${String(row.warpTarget)}`);
  }
  return parts.join(" · ");
}

function phaseClass(phase: string): string {
  return PHASE_CLASSES.has(phase) ? phase : "unknown";
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
    return "—";
  }
  return `${formatBytes(bytesPerSecond)}/s`;
}
