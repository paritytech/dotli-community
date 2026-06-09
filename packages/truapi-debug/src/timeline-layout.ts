// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// TrUAPI timeline layout engine
//
// Pure function that takes the visible event list and produces a
// geometry description: rails (chainHead follow subscriptions), boxes
// (everything else with a request/response lifetime), and ticks (zero-
// duration chain-lifecycle events drawn on the left margin strip).
//
// No DOM, no SVG. The renderer consumes the `Layout` shape verbatim.
//
// Correlation strategy:
//   1. TrUAPI requestId groups every event that shares a single
//      transport-level id (request+response, or subscription start+
//      receives+stop).
//   2. chainHead follow subscriptions become rails, ordered per
//      (productId, genesisHash). The Nth follow-start for a pair
//      corresponds to synthetic id `follow_N` produced by the
//      SDK's papiProvider.
//   3. chainHead operations (body/storage/call) correlate to their
//      follow rail via `followSubscriptionId` in the request payload.
//      Their terminal event (OperationBodyDone / OperationCallDone /
//      OperationStorageDone / OperationError / OperationInaccessible)
//      arrives on the follow subscription carrying a matching
//      operationId.

import {
  decodeChainAnnotations,
  formatChainLabel,
  type ChainAnnotations,
} from "./chain-decode.ts";
import { formatChainDisplay } from "./chain-registry.ts";
import type {
  EventSeq,
  StoredEvent,
  StoredSystemEvent,
  StoredTruapiEvent,
} from "./event-store.ts";

/** Vertical pixels each event occupies. Intentionally small: box
 *  labels moved to the hover tooltip so the timeline can be vertically
 *  dense and show hundreds of events without scrolling. */
export const ROW_HEIGHT = 7;

/** Width of the left margin reserved for chain-lifecycle ticks. */
export const MARGIN_WIDTH = 16;

/** Horizontal pixels per follow-subscription rail column. */
export const RAIL_COL_WIDTH = 8;

/** Gap between the rightmost rail and the first lane. */
export const LANE_GUTTER = 8;

/** Width of a single lane (and of the box drawn in it). Very narrow:
 *  identification is through the hover tooltip (method name and details)
 *  plus the requestId-hash colour, not inline text. */
export const LANE_WIDTH = 28;

/** Horizontal gap between adjacent lanes. */
export const LANE_GAP = 3;

/** Lifecycle event tags that become margin ticks rather than segments. */
const LIFECYCLE_VARIANTS: ReadonlySet<string> = new Set([
  "Initialized",
  "NewBlock",
  "BestBlockChanged",
  "Finalized",
  "Stop",
]);

/** Variants that terminate a chain operation. */
const OPERATION_TERMINAL_VARIANTS: ReadonlySet<string> = new Set([
  "OperationBodyDone",
  "OperationCallDone",
  "OperationStorageDone",
  "OperationError",
  "OperationInaccessible",
]);

/** Human-readable color per lifecycle variant for the margin ticks. */
const LIFECYCLE_COLORS: Record<string, string> = {
  Initialized: "#3b82f6", // blue
  NewBlock: "#60a5fa", // lighter blue
  BestBlockChanged: "#fbbf24", // amber
  Finalized: "#4ade80", // green
  Stop: "#f87171", // red
};

export interface SegmentEntry {
  kind: "segment";
  /** Selection anchor, typically the start (request/_start) event. */
  seqAnchor: EventSeq;
  /** Every event this segment represents, for click hit-testing. */
  memberSeqs: EventSeq[];
  topY: number;
  bottomY: number;
  lane: number;
  color: string;
  /** Short label rendered on the box (e.g. "chainHead.body"). */
  label: string;
  /** Secondary text rendered inside the box (block hash, opId tail, etc.). */
  detail?: string;
  /** Pending = terminal event not yet observed. Renderer draws dashed bottom. */
  pending: boolean;
  /** If this segment is a chain operation against a follow rail, the rail's index. */
  linkedRailIdx?: number;
}

export interface RailEntry {
  kind: "rail";
  seqAnchor: EventSeq;
  memberSeqs: EventSeq[];
  topY: number;
  bottomY: number;
  /** 0-based column in the rails strip. */
  railIdx: number;
  color: string;
  /** Genesis short hash plus ordinal for multi-follow cases, e.g. "0x12ab…cdef #0". */
  label: string;
  pending: boolean;
}

export interface TickEntry {
  kind: "tick";
  seq: EventSeq;
  y: number;
  color: string;
  variant: string;
  /** Rail this tick belongs to; `null` for orphaned ticks (rail evicted). */
  linkedRailIdx: number | null;
}

export type TimelineEntry = SegmentEntry | RailEntry | TickEntry;

export interface Layout {
  entries: TimelineEntry[];
  laneCount: number;
  railCount: number;
  totalHeight: number;
  /** Maps any member seq to its index into `entries` for O(1) seq-based lookups. */
  seqToEntryIdx: Map<EventSeq, number>;
}

interface WorkingSegment {
  seqAnchor: EventSeq;
  memberSeqs: EventSeq[];
  topY: number;
  bottomY: number;
  color: string;
  label: string;
  detail?: string;
  pending: boolean;
  linkedRailIdx?: number;
  startAt: number;
  /** endAt = null for open-ended (pending) segments. */
  endAt: number | null;
}

export interface LayoutOptions {
  /**
   * Maps every event's seq to its Y coordinate in the shared timeline
   * space. Typically produced by `computeGlobalYPositions` over the
   * full filtered event list so swimlanes share one vertical axis.
   */
  seqToY: Map<EventSeq, number>;
  /** Height of the shared vertical axis (matches the outer scroll extent). */
  totalHeight: number;
}

/** Precompute the Y coordinate for every event in the visible list.
 *  Shared across swimlanes so horizontally-adjacent boxes at the same
 *  Y represent the same moment in time. */
export function computeGlobalYPositions(
  events: readonly StoredEvent[],
): LayoutOptions {
  const seqToY = new Map<EventSeq, number>();
  events.forEach((ev, i) => seqToY.set(ev.seq, i * ROW_HEIGHT));
  const totalHeight = Math.max(1, events.length) * ROW_HEIGHT;
  return { seqToY, totalHeight };
}

export interface SwimlanePartition {
  /** Stable key identifying the lane (`"chain-<genesisHash>"` or `"other"`). */
  key: string;
  /** Human-readable lane header (short genesis hash or `"Other"`). */
  header: string;
  /** Accent color for the header (derived from genesisHash). */
  color: string;
  /** Events assigned to this lane, in their original order. */
  events: StoredEvent[];
}

/**
 * Split the visible event list into swimlanes. A chain swimlane only
 * appears for a genesisHash that has at least one
 * `remote_chain_head_follow_start` in the buffer. A follow is what
 * signals the product is actively interacting with that chain, not
 * just looking up a chainSpec. Chain events for genesis hashes
 * without a follow (and chain events we can't associate with a
 * genesisHash at all) fall through to `"other"`, alongside every
 * non-chain message.
 *
 * Follow-receive events that lack a genesisHash in their payload
 * inherit it from their parent follow subscription (same TrUAPI
 * requestId), picked up in the first pass below.
 */
export function partitionIntoSwimlanes(
  events: readonly StoredEvent[],
): SwimlanePartition[] {
  // First pass: map truapi requestId to genesisHash wherever any event
  // in the group carries it, AND collect the set of genesisHashes for
  // which a follow subscription has been observed. System events don't
  // contribute here; they all funnel into the dedicated System swimlane.
  const ridToGenesis = new Map<string, string>();
  const followedGenesis = new Set<string>();
  for (const ev of events) {
    if (ev.kind !== "truapi") {
      continue;
    }
    const ann = decodeChainAnnotations(ev.tag, ev.payload);
    const gen = ann?.genesisHash;
    if (gen !== undefined && !ridToGenesis.has(ev.requestId)) {
      ridToGenesis.set(ev.requestId, gen);
    }
    if (ev.tag === "remote_chain_head_follow_start" && gen !== undefined) {
      followedGenesis.add(gen);
    }
  }

  // Second pass: partition. Chain events land in `chain-<gen>` only if
  // that genesis has been followed; otherwise they spill into `other`.
  // System events all go into the `system` swimlane.
  const buckets = new Map<string, StoredEvent[]>();
  for (const ev of events) {
    const key = swimlaneKeyFor(ev, ridToGenesis, followedGenesis);
    const list = buckets.get(key) ?? [];
    list.push(ev);
    buckets.set(key, list);
  }

  // Sort: chain swimlanes first (by genesisHash), then "system", then "other".
  const keys = Array.from(buckets.keys()).sort((a, b) => {
    const rank = (k: string): number => {
      if (k === "other") {
        return 3;
      }
      if (k === "system") {
        return 2;
      }
      return 1;
    };
    const rd = rank(a) - rank(b);
    if (rd !== 0) {
      return rd;
    }
    return a.localeCompare(b);
  });

  return keys.map((key) => {
    const evts = buckets.get(key) ?? [];
    if (key === "other") {
      return {
        key,
        header: "Other",
        color: "#94a3b8",
        events: evts,
      };
    }
    if (key === "system") {
      return {
        key,
        header: "System",
        color: "#2dd4bf",
        events: evts,
      };
    }
    const genesisHash = key.slice("chain-".length);
    return {
      key,
      header: formatChainDisplay(genesisHash),
      color: hashColor(genesisHash, 60, 60),
      events: evts,
    };
  });
}

function swimlaneKeyFor(
  ev: StoredEvent,
  ridToGenesis: Map<string, string>,
  followedGenesis: Set<string>,
): string {
  if (ev.kind === "system") {
    return "system";
  }
  if (!ev.tag.startsWith("remote_chain_")) {
    return "other";
  }
  const gen = ridToGenesis.get(ev.requestId);
  if (gen === undefined || !followedGenesis.has(gen)) {
    return "other";
  }
  return `chain-${gen}`;
}

export function computeLayout(
  events: readonly StoredEvent[],
  opts: LayoutOptions,
): Layout {
  const { seqToY, totalHeight } = opts;
  const nowY = totalHeight;

  // Group by correlation key. TrUAPI events key on requestId,
  // system events key on flowId.
  const groups = new Map<string, StoredEvent[]>();
  for (const ev of events) {
    const key = ev.kind === "truapi" ? ev.requestId : ev.flowId;
    const g = groups.get(key);
    if (g !== undefined) {
      g.push(ev);
    } else {
      groups.set(key, [ev]);
    }
  }

  // Phase A: rails (follow subscriptions).
  // For each (productId, genesisHash) pair, order follow-starts by time
  // and assign an ordinal to each rail index. This lets us resolve
  // "followSubscriptionId = follow_N" references later. Only truapi
  // events are candidates. System events never become rails.
  const followKeyToRails = new Map<string, RailEntry[]>();
  const rails: RailEntry[] = [];
  const railByTruapiReqId = new Map<string, RailEntry>();
  let nextRailIdx = 0;

  for (const ev of events) {
    if (ev.kind !== "truapi") {
      continue;
    }
    if (ev.tag !== "remote_chain_head_follow_start") {
      continue;
    }
    const ann = decodeChainAnnotations(ev.tag, ev.payload);
    const key = followKey(ev.productId, ann?.genesisHash);
    const existing = followKeyToRails.get(key) ?? [];

    // Terminal boundary of the rail = the Stop receive on its follow
    // subscription (same TrUAPI requestId), if any. If missing, rail is
    // drawn as pending to `now`.
    const group = groups.get(ev.requestId) ?? [];
    const stop = group.find((g) => {
      if (g.kind !== "truapi") {
        return false;
      }
      if (g.tag !== "remote_chain_head_follow_receive") {
        return false;
      }
      const a = decodeChainAnnotations(g.tag, g.payload);
      return a?.chainEventTag === "Stop";
    });

    const ordinal = existing.length;
    const rail: RailEntry = {
      kind: "rail",
      seqAnchor: ev.seq,
      memberSeqs: [ev.seq, ...(stop === undefined ? [] : [stop.seq])],
      topY: seqToY.get(ev.seq) ?? 0,
      bottomY:
        stop === undefined ? nowY : (seqToY.get(stop.seq) ?? nowY) + ROW_HEIGHT,
      railIdx: nextRailIdx++,
      color: hashColor(ann?.genesisHash ?? "", 60, 55),
      label: railLabel(ann?.genesisHash, ordinal),
      pending: stop === undefined,
    };
    rails.push(rail);
    railByTruapiReqId.set(ev.requestId, rail);
    existing.push(rail);
    followKeyToRails.set(key, existing);
  }

  // Phase B: build segments and ticks.
  // Walk groups once. Each TrUAPI requestId yields either (a) a
  // segment (request/response, subscription), or (b) is the follow
  // subscription itself which is already materialised as a rail and
  // whose receives are ticks / attached operation terminals.
  const working: WorkingSegment[] = [];
  const ticks: TickEntry[] = [];
  /** Maps operationId to its terminal event (on a follow subscription), so
   *  chainHead.body/storage/call request/response pairs can extend
   *  their segment to the terminal event. Only populated from truapi
   *  follow-receive events. */
  const terminalByOpId = new Map<string, StoredTruapiEvent>();

  // First pre-scan: index every terminal operation event by its operationId.
  for (const ev of events) {
    if (ev.kind !== "truapi") {
      continue;
    }
    if (ev.tag !== "remote_chain_head_follow_receive") {
      continue;
    }
    const ann = decodeChainAnnotations(ev.tag, ev.payload);
    if (
      ann?.operationId !== undefined &&
      ann.chainEventTag !== undefined &&
      OPERATION_TERMINAL_VARIANTS.has(ann.chainEventTag)
    ) {
      if (!terminalByOpId.has(ann.operationId)) {
        terminalByOpId.set(ann.operationId, ev);
      }
    }
  }

  for (const [correlationKey, group] of groups) {
    // Already materialised as a rail (truapi follow subscription). Its
    // receives need to be dispatched into ticks (lifecycle) or attached
    // operation events (handled below via terminalByOpId).
    const rail = railByTruapiReqId.get(correlationKey);
    if (rail !== undefined) {
      for (const ev of group) {
        if (ev.kind !== "truapi") {
          continue;
        }
        if (ev.tag !== "remote_chain_head_follow_receive") {
          continue;
        }
        const ann = decodeChainAnnotations(ev.tag, ev.payload);
        if (
          ann?.chainEventTag !== undefined &&
          LIFECYCLE_VARIANTS.has(ann.chainEventTag)
        ) {
          ticks.push({
            kind: "tick",
            seq: ev.seq,
            y: (seqToY.get(ev.seq) ?? 0) + ROW_HEIGHT / 2,
            color: LIFECYCLE_COLORS[ann.chainEventTag] ?? "#6b7280",
            variant: ann.chainEventTag,
            linkedRailIdx: rail.railIdx,
          });
        }
      }
      continue;
    }

    // System group always produces a segment (flow box or singleton pill).
    if (group.length > 0 && group[0].kind === "system") {
      const seg = systemSegmentForGroup(group as StoredSystemEvent[], seqToY);
      working.push(seg);
      continue;
    }

    // TrUAPI non-rail group uses the segment logic (request/response,
    // chain operation spanning to terminal event on follow, etc.).
    const truapiGroup = group.filter(
      (e): e is StoredTruapiEvent => e.kind === "truapi",
    );
    if (truapiGroup.length === 0) {
      continue;
    }
    const seg = segmentForGroup(
      truapiGroup,
      seqToY,
      nowY,
      terminalByOpId,
      followKeyToRails,
    );
    if (seg !== null) {
      working.push(seg);
    }
  }

  // Sort segments by topY for deterministic lane assignment.
  working.sort((a, b) => a.topY - b.topY || a.seqAnchor - b.seqAnchor);

  // Phase C: lane-pack.
  // Greedy leftmost assignment. A lane is "free" from the Y-coordinate
  // where its last segment ended. Pending segments block their lane
  // until the terminal event arrives, modelled by using `nowY` as
  // their occupied-until boundary.
  const laneOccupiedUntil: number[] = [];
  const segmentsOut: SegmentEntry[] = [];
  for (const s of working) {
    let lane = -1;
    for (let i = 0; i < laneOccupiedUntil.length; i++) {
      if (laneOccupiedUntil[i] <= s.topY) {
        lane = i;
        break;
      }
    }
    if (lane === -1) {
      lane = laneOccupiedUntil.length;
      laneOccupiedUntil.push(0);
    }
    // A pending segment's effective end is `nowY`; plain segments end at
    // their `bottomY`. Lanes are only released after the effective end.
    laneOccupiedUntil[lane] = s.pending ? nowY : s.bottomY;

    segmentsOut.push({
      kind: "segment",
      seqAnchor: s.seqAnchor,
      memberSeqs: s.memberSeqs,
      topY: s.topY,
      bottomY: s.bottomY,
      lane,
      color: s.color,
      label: s.label,
      detail: s.detail,
      pending: s.pending,
      linkedRailIdx: s.linkedRailIdx,
    });
  }

  // Assemble final layout.
  const entries: TimelineEntry[] = [...rails, ...segmentsOut, ...ticks];
  const seqToEntryIdx = new Map<EventSeq, number>();
  entries.forEach((entry, idx) => {
    if (entry.kind === "tick") {
      seqToEntryIdx.set(entry.seq, idx);
      return;
    }
    for (const seq of entry.memberSeqs) {
      seqToEntryIdx.set(seq, idx);
    }
  });

  return {
    entries,
    laneCount: laneOccupiedUntil.length,
    railCount: rails.length,
    totalHeight,
    seqToEntryIdx,
  };
}

function segmentForGroup(
  group: StoredTruapiEvent[],
  seqToY: Map<EventSeq, number>,
  nowY: number,
  terminalByOpId: Map<string, StoredTruapiEvent>,
  followKeyToRails: Map<string, RailEntry[]>,
): WorkingSegment | null {
  // Sort by seq (stable order) so "first" / "last" below mean first observed.
  const sorted = [...group].sort((a, b) => a.seq - b.seq);
  if (sorted.length === 0) {
    return null;
  }
  const first = sorted[0];

  // The timeline only draws boxes for request/response-shaped flows.
  // Subscriptions (anything whose first observed event is `_start`, or
  // whose group carries `_receive`/`_stop`/`_interrupt` without a
  // `_request`) are intentionally invisible here. They have no
  // bounded "response time" to visualise. chainHead.follow is the
  // important exception, materialised as a rail in an earlier phase.
  const hasRequest = sorted.some((e) => e.tag.endsWith("_request"));
  if (!hasRequest) {
    return null;
  }

  const chain = decodeChainAnnotations(first.tag, first.payload);
  const isOperationStarter =
    chain?.kind === "head-body-request" ||
    chain?.kind === "head-storage-request" ||
    chain?.kind === "head-call-request";

  // Chain operations (body/storage/call): the segment spans from the
  // request to the terminal operation event on the follow subscription,
  // not to the TrUAPI response. The response just conveys the
  // operationId needed to correlate.
  //
  // Direction note: `incoming` is product-to-host, `outgoing` is
  // host-to-product. So a `_request` is incoming and its `_response` is
  // outgoing.
  if (isOperationStarter) {
    const response = sorted.find(
      (e) => e.seq !== first.seq && e.tag.endsWith("_response"),
    );
    const respAnn =
      response === undefined
        ? undefined
        : decodeChainAnnotations(response.tag, response.payload);
    const opId = respAnn?.operationId;

    const linkedRailIdx = linkRail(first, chain, followKeyToRails);

    const terminal = opId !== undefined ? terminalByOpId.get(opId) : undefined;
    const memberSeqs: EventSeq[] = [first.seq];
    if (response !== undefined) {
      memberSeqs.push(response.seq);
    }
    if (terminal !== undefined) {
      memberSeqs.push(terminal.seq);
    }

    const endSeq = terminal?.seq ?? response?.seq;
    const pending =
      terminal === undefined &&
      (response === undefined || respAnn?.outcome === "started");

    return {
      seqAnchor: first.seq,
      memberSeqs,
      topY: seqToY.get(first.seq) ?? 0,
      bottomY:
        endSeq === undefined ? nowY : (seqToY.get(endSeq) ?? nowY) + ROW_HEIGHT,
      color: hashColor(first.requestId, 65, 65),
      label: formatChainLabel(chain),
      detail: opBoxDetail(chain, respAnn, terminal),
      pending,
      linkedRailIdx,
      startAt: first.receivedAt,
      endAt: terminal?.receivedAt ?? response?.receivedAt ?? null,
    };
  }

  // Any other group: plain request/response, simple chain call, or
  // generic subscription. Span from first to last member, pending if
  // we never saw a terminating message. Matching by suffix because
  // response/interrupt are outgoing and stop is incoming. Checking
  // direction here would drop legitimate terminators.
  const hasTerminator = sorted.some(
    (e) =>
      e.tag.endsWith("_response") ||
      e.tag.endsWith("_stop") ||
      e.tag.endsWith("_interrupt"),
  );
  const last = sorted[sorted.length - 1];
  const label =
    chain === null ? prettyTagLabel(first.tag) : formatChainLabel(chain);

  return {
    seqAnchor: first.seq,
    memberSeqs: sorted.map((e) => e.seq),
    topY: seqToY.get(first.seq) ?? 0,
    bottomY: (seqToY.get(last.seq) ?? nowY) + ROW_HEIGHT,
    color: hashColor(first.requestId, 65, 65),
    label,
    detail:
      chain?.blockHash !== undefined
        ? `blk ${shortHex(chain.blockHash)}`
        : undefined,
    pending: !hasTerminator,
    startAt: first.receivedAt,
    endAt: hasTerminator ? last.receivedAt : null,
  };
}

/**
 * Build a WorkingSegment from a system-event flow group. Multi-event
 * flows render as boxes spanning first to last. Single-event flows
 * become pills, a one-row-tall box with no pending marker, so that
 * point-in-time system events (boot phases, failover decisions, etc.)
 * still occupy a lane position at the right Y. `pending` is true for
 * flows whose first event is a "start" kind without a matching end
 * event in the buffer. See SYSTEM_TERMINATOR_SUFFIXES.
 */
function systemSegmentForGroup(
  group: StoredSystemEvent[],
  seqToY: Map<EventSeq, number>,
): WorkingSegment {
  const sorted = [...group].sort((a, b) => a.seq - b.seq);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const pending =
    sorted.length > 1 && !sorted.some((e) => isSystemFlowTerminator(e));
  const label = `${first.layer}.${first.event}`.replace(/_/g, ".");
  return {
    seqAnchor: first.seq,
    memberSeqs: sorted.map((e) => e.seq),
    topY: seqToY.get(first.seq) ?? 0,
    bottomY: (seqToY.get(last.seq) ?? 0) + ROW_HEIGHT,
    color: hashColor(first.flowId, 60, 62),
    label,
    detail: systemSegmentDetail(first, sorted),
    pending,
    startAt: first.receivedAt,
    endAt: pending ? null : last.receivedAt,
  };
}

function systemSegmentDetail(
  first: StoredSystemEvent,
  all: StoredSystemEvent[],
): string | undefined {
  if (all.length === 1) {
    return undefined;
  }
  return `${first.layer}·${String(all.length)} step${all.length === 1 ? "" : "s"}`;
}

/** Events that close a multi-step system flow. Mirrors the pairs we
 *  document in the detail pane so visual pending state matches intent. */
const SYSTEM_TERMINATOR_SUFFIXES: readonly string[] = [
  "ready",
  "failed",
  "landing_page_shown",
  "completed",
  "session_established",
  "pairing_failed",
  "terminated",
  "iframe_ready",
  // `setup_ready` does not close the bridge flow. It only means the
  // host is listening, and the product can stay silent for many seconds
  // after that (iframe still loading, sandbox relay not ready). The
  // bridge flow stays open until bidirectional traffic is observed via
  // `first_outbound`.
  "first_outbound",
  "document_written",
  "peer_action_processed",
  "peer_action_failed",
  "host_action_response_received",
  "host_action_failed",
  "resolve_completed",
  "resolve_failed",
];

function isSystemFlowTerminator(ev: StoredSystemEvent): boolean {
  const event = ev.event;
  return SYSTEM_TERMINATOR_SUFFIXES.some(
    (suf) => event === suf || event.endsWith(`_${suf}`) || event === suf,
  );
}

function opBoxDetail(
  reqChain: ChainAnnotations | null,
  respChain: ChainAnnotations | null | undefined,
  terminal: StoredTruapiEvent | undefined,
): string | undefined {
  const parts: string[] = [];
  if (reqChain?.blockHash !== undefined) {
    parts.push(`blk ${shortHex(reqChain.blockHash)}`);
  }
  if (respChain?.operationId !== undefined) {
    parts.push(`op ${shortHex(respChain.operationId)}`);
  } else if (respChain?.outcome === "limit-reached") {
    parts.push("limit-reached");
  } else if (respChain?.outcome === "error") {
    parts.push(`err: ${respChain.errorMessage ?? "?"}`);
  }
  if (terminal !== undefined) {
    const tann = decodeChainAnnotations(terminal.tag, terminal.payload);
    if (tann?.chainEventTag !== undefined) {
      parts.push(`→ ${tann.chainEventTag}`);
    }
  }
  return parts.length === 0 ? undefined : parts.join(" · ");
}

// Resolve a chain-operation request's rail via the synthetic followSub id.
// See the module header for the correlation rules.
function linkRail(
  requestEvent: StoredTruapiEvent,
  chain: ChainAnnotations,
  followKeyToRails: Map<string, RailEntry[]>,
): number | undefined {
  const syntheticId = chain.followSubscriptionId;
  if (syntheticId === undefined) {
    return undefined;
  }
  const key = followKey(requestEvent.productId, chain.genesisHash);
  const rails = followKeyToRails.get(key);
  if (rails === undefined || rails.length === 0) {
    return undefined;
  }
  // papiProvider's synthetic ids are `follow_N`.
  const match = /^follow_(\d+)$/.exec(syntheticId);
  if (match === null) {
    return undefined;
  }
  const ordinal = Number(match[1]);
  // Clamp to the buffer: if the original follow-start was evicted we can't
  // resolve. Fall back to the last rail for this (product, genesis) as a
  // best-effort guess, better than nothing for a debug overlay.
  const rail = rails[ordinal] ?? rails[rails.length - 1];
  return rail.railIdx;
}

function followKey(
  productId: string | undefined,
  genesisHash: string | undefined,
): string {
  return `${productId ?? "__anon"}|${genesisHash ?? "__unknown"}`;
}

function hashColor(input: string, sat = 65, light = 65): string {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = (h * 31 + input.charCodeAt(i)) | 0;
  }
  const hue = ((h % 360) + 360) % 360;
  return `hsl(${String(hue)}, ${String(sat)}%, ${String(light)}%)`;
}

function railLabel(genesisHash: string | undefined, ordinal: number): string {
  const prefix =
    genesisHash === undefined ? "(no chain)" : formatChainDisplay(genesisHash);
  return ordinal === 0 ? prefix : `${prefix} #${String(ordinal)}`;
}

function shortHex(v: string): string {
  // Compact form suitable for a narrow box detail line. The detail
  // pane shows the full value, so this is just for at-a-glance scanning.
  if (v.startsWith("0x") && v.length > 8) {
    return `${v.slice(0, 6)}…`;
  }
  if (v.length > 8) {
    return `${v.slice(0, 6)}…`;
  }
  return v;
}

function prettyTagLabel(tag: string): string {
  // Box labels are narrow. Strip the `host_` / `remote_` family
  // prefix and the direction suffix, and turn remaining underscores
  // into dots so the label splits cleanly across two lines in the
  // renderer (matching the `chainHead.follow` style used by chain
  // methods).
  return tag
    .replace(/^(remote_|host_)/, "")
    .replace(
      /_(request|response|start|receive|stop|submit|interrupt|subscribe)$/,
      "",
    )
    .replace(/_/g, ".");
}
