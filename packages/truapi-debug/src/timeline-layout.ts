// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Rails are chainHead follow subscriptions, ticks their lifecycle events, boxes everything else.
// An operation's `follow_N` id names the Nth follow-start per (product, genesis), and its box
// ends at the follow event carrying its operationId.

import { decodeChainAnnotations, formatChainLabel, type ChainAnnotations } from './chain-decode.js';
import { formatChainDisplay } from './chain-registry.js';
import type { EventSeq, StoredEvent, StoredSystemEvent, StoredTruapiEvent } from './event-store.js';

/** Small because box labels live in the hover tooltip. */
export const ROW_HEIGHT = 7;

export const MARGIN_WIDTH = 16;

export const RAIL_COL_WIDTH = 8;

export const LANE_GUTTER = 8;

/** Narrow because boxes are told apart by tooltip and color, not inline text. */
export const LANE_WIDTH = 28;

export const LANE_GAP = 3;

const LIFECYCLE_VARIANTS: ReadonlySet<string> = new Set([
  'Initialized',
  'NewBlock',
  'BestBlockChanged',
  'Finalized',
  'Stop',
]);

const OPERATION_TERMINAL_VARIANTS: ReadonlySet<string> = new Set([
  'OperationBodyDone',
  'OperationCallDone',
  'OperationStorageDone',
  'OperationError',
  'OperationInaccessible',
]);

const LIFECYCLE_COLORS: Record<string, string> = {
  Initialized: '#3b82f6',
  NewBlock: '#60a5fa',
  BestBlockChanged: '#fbbf24',
  Finalized: '#4ade80',
  Stop: '#f87171',
};

export interface SegmentEntry {
  kind: 'segment';
  seqAnchor: EventSeq;
  memberSeqs: EventSeq[];
  topY: number;
  bottomY: number;
  lane: number;
  color: string;
  label: string;
  detail?: string | undefined;
  /** The terminal event has not arrived yet. */
  pending: boolean;
  linkedRailIdx?: number | undefined;
}

export interface RailEntry {
  kind: 'rail';
  seqAnchor: EventSeq;
  memberSeqs: EventSeq[];
  topY: number;
  bottomY: number;
  railIdx: number;
  color: string;
  label: string;
  pending: boolean;
}

export interface TickEntry {
  kind: 'tick';
  seq: EventSeq;
  y: number;
  color: string;
  variant: string;
  /** Null when the rail was evicted. */
  linkedRailIdx: number | null;
}

export type TimelineEntry = SegmentEntry | RailEntry | TickEntry;

export interface Layout {
  entries: TimelineEntry[];
  laneCount: number;
  railCount: number;
  totalHeight: number;
  seqToEntryIdx: Map<EventSeq, number>;
}

interface WorkingSegment {
  seqAnchor: EventSeq;
  memberSeqs: EventSeq[];
  topY: number;
  bottomY: number;
  color: string;
  label: string;
  detail?: string | undefined;
  pending: boolean;
  linkedRailIdx?: number | undefined;
  startAt: number;
  endAt: number | null;
}

export interface LayoutOptions {
  seqToY: Map<EventSeq, number>;
  totalHeight: number;
}

/** Shared across swimlanes so boxes at the same Y are the same moment. */
export function computeGlobalYPositions(events: readonly StoredEvent[]): LayoutOptions {
  const seqToY = new Map<EventSeq, number>();
  events.forEach((ev, i) => seqToY.set(ev.seq, i * ROW_HEIGHT));
  const totalHeight = Math.max(1, events.length) * ROW_HEIGHT;
  return { seqToY, totalHeight };
}

export interface SwimlanePartition {
  /** `chain-<genesisHash>`, `system` or `other`. */
  key: string;
  header: string;
  color: string;
  events: StoredEvent[];
}

/**
 * A chain gets its own lane only once followed, since a follow means the product actively uses it.
 * Other chain events fall into `other`.
 */
export function partitionIntoSwimlanes(events: readonly StoredEvent[]): SwimlanePartition[] {
  // Follow-receives carry no genesisHash, so they inherit it through their requestId.
  const ridToGenesis = new Map<string, string>();
  const followedGenesis = new Set<string>();
  for (const ev of events) {
    if (ev.kind !== 'truapi') {
      continue;
    }
    const ann = decodeChainAnnotations(ev.tag, ev.payload);
    const gen = ann?.genesisHash;
    if (gen !== undefined && !ridToGenesis.has(ev.requestId)) {
      ridToGenesis.set(ev.requestId, gen);
    }
    if (ev.tag === 'remote_chain_head_follow_start' && gen !== undefined) {
      followedGenesis.add(gen);
    }
  }

  const buckets = new Map<string, StoredEvent[]>();
  for (const ev of events) {
    const key = swimlaneKeyFor(ev, ridToGenesis, followedGenesis);
    const list = buckets.get(key) ?? [];
    list.push(ev);
    buckets.set(key, list);
  }

  const keys = Array.from(buckets.keys()).sort((a, b) => {
    const rank = (k: string): number => {
      if (k === 'other') {
        return 3;
      }
      if (k === 'system') {
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

  return keys.map(key => {
    const evts = buckets.get(key) ?? [];
    if (key === 'other') {
      return {
        key,
        header: 'Other',
        color: '#94a3b8',
        events: evts,
      };
    }
    if (key === 'system') {
      return {
        key,
        header: 'System',
        color: '#2dd4bf',
        events: evts,
      };
    }
    const genesisHash = key.slice('chain-'.length);
    return {
      key,
      header: formatChainDisplay(genesisHash),
      color: hashColor(genesisHash, 60, 60),
      events: evts,
    };
  });
}

function swimlaneKeyFor(ev: StoredEvent, ridToGenesis: Map<string, string>, followedGenesis: Set<string>): string {
  if (ev.kind === 'system') {
    return 'system';
  }
  if (!ev.tag.startsWith('remote_chain_')) {
    return 'other';
  }
  const gen = ridToGenesis.get(ev.requestId);
  if (gen === undefined || !followedGenesis.has(gen)) {
    return 'other';
  }
  return `chain-${gen}`;
}

export function computeLayout(events: readonly StoredEvent[], opts: LayoutOptions): Layout {
  const { seqToY, totalHeight } = opts;
  const nowY = totalHeight;

  const groups = new Map<string, StoredEvent[]>();
  for (const ev of events) {
    const key = ev.kind === 'truapi' ? ev.requestId : ev.flowId;
    const g = groups.get(key);
    if (g !== undefined) {
      g.push(ev);
    } else {
      groups.set(key, [ev]);
    }
  }

  const followKeyToRails = new Map<string, RailEntry[]>();
  const rails: RailEntry[] = [];
  const railByTruapiReqId = new Map<string, RailEntry>();
  let nextRailIdx = 0;

  for (const ev of events) {
    if (ev.kind !== 'truapi') {
      continue;
    }
    if (ev.tag !== 'remote_chain_head_follow_start') {
      continue;
    }
    const ann = decodeChainAnnotations(ev.tag, ev.payload);
    const key = followKey(ev.productId, ann?.genesisHash);
    const existing = followKeyToRails.get(key) ?? [];

    const group = groups.get(ev.requestId) ?? [];
    const stop = group.find(g => {
      if (g.kind !== 'truapi') {
        return false;
      }
      if (g.tag !== 'remote_chain_head_follow_receive') {
        return false;
      }
      const a = decodeChainAnnotations(g.tag, g.payload);
      return a?.chainEventTag === 'Stop';
    });

    const ordinal = existing.length;
    const rail: RailEntry = {
      kind: 'rail',
      seqAnchor: ev.seq,
      memberSeqs: [ev.seq, ...(stop === undefined ? [] : [stop.seq])],
      topY: seqToY.get(ev.seq) ?? 0,
      bottomY: stop === undefined ? nowY : (seqToY.get(stop.seq) ?? nowY) + ROW_HEIGHT,
      railIdx: nextRailIdx++,
      color: hashColor(ann?.genesisHash ?? '', 60, 55),
      label: railLabel(ann?.genesisHash, ordinal),
      pending: stop === undefined,
    };
    rails.push(rail);
    railByTruapiReqId.set(ev.requestId, rail);
    existing.push(rail);
    followKeyToRails.set(key, existing);
  }

  const working: WorkingSegment[] = [];
  const ticks: TickEntry[] = [];
  const terminalByOpId = new Map<string, StoredTruapiEvent>();

  for (const ev of events) {
    if (ev.kind !== 'truapi') {
      continue;
    }
    if (ev.tag !== 'remote_chain_head_follow_receive') {
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
    const rail = railByTruapiReqId.get(correlationKey);
    if (rail !== undefined) {
      for (const ev of group) {
        if (ev.kind !== 'truapi') {
          continue;
        }
        if (ev.tag !== 'remote_chain_head_follow_receive') {
          continue;
        }
        const ann = decodeChainAnnotations(ev.tag, ev.payload);
        if (ann?.chainEventTag !== undefined && LIFECYCLE_VARIANTS.has(ann.chainEventTag)) {
          ticks.push({
            kind: 'tick',
            seq: ev.seq,
            y: (seqToY.get(ev.seq) ?? 0) + ROW_HEIGHT / 2,
            color: LIFECYCLE_COLORS[ann.chainEventTag] ?? '#6b7280',
            variant: ann.chainEventTag,
            linkedRailIdx: rail.railIdx,
          });
        }
      }
      continue;
    }

    if (group[0]?.kind === 'system') {
      const seg = systemSegmentForGroup(group as StoredSystemEvent[], seqToY);
      working.push(seg);
      continue;
    }

    const truapiGroup = group.filter((e): e is StoredTruapiEvent => e.kind === 'truapi');
    if (truapiGroup.length === 0) {
      continue;
    }
    const seg = segmentForGroup(truapiGroup, seqToY, nowY, terminalByOpId, followKeyToRails);
    if (seg !== null) {
      working.push(seg);
    }
  }

  // Sorted for deterministic lane assignment.
  working.sort((a, b) => a.topY - b.topY || a.seqAnchor - b.seqAnchor);

  // Greedy leftmost lane packing. A pending segment holds its lane until `nowY`.
  const laneOccupiedUntil: number[] = [];
  const segmentsOut: SegmentEntry[] = [];
  for (const s of working) {
    let lane = laneOccupiedUntil.findIndex(until => until <= s.topY);
    if (lane === -1) {
      lane = laneOccupiedUntil.length;
      laneOccupiedUntil.push(0);
    }
    laneOccupiedUntil[lane] = s.pending ? nowY : s.bottomY;

    segmentsOut.push({
      kind: 'segment',
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

  const entries: TimelineEntry[] = [...rails, ...segmentsOut, ...ticks];
  const seqToEntryIdx = new Map<EventSeq, number>();
  entries.forEach((entry, idx) => {
    if (entry.kind === 'tick') {
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
  const sorted = [...group].sort((a, b) => a.seq - b.seq);
  const first = sorted[0];
  if (first === undefined) {
    return null;
  }

  // Subscriptions have no bounded response time to draw. chainHead.follow is a rail instead.
  const hasRequest = sorted.some(e => e.tag.endsWith('_request'));
  if (!hasRequest) {
    return null;
  }

  const chain = decodeChainAnnotations(first.tag, first.payload);
  const isOperationStarter =
    chain?.kind === 'head-body-request' ||
    chain?.kind === 'head-storage-request' ||
    chain?.kind === 'head-call-request';

  // The response only carries the operationId. The operation ends at its terminal follow event.
  if (isOperationStarter) {
    const response = sorted.find(e => e.seq !== first.seq && e.tag.endsWith('_response'));
    const respAnn = response === undefined ? undefined : decodeChainAnnotations(response.tag, response.payload);
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
    const pending = terminal === undefined && (response === undefined || respAnn?.outcome === 'started');

    return {
      seqAnchor: first.seq,
      memberSeqs,
      topY: seqToY.get(first.seq) ?? 0,
      bottomY: endSeq === undefined ? nowY : (seqToY.get(endSeq) ?? nowY) + ROW_HEIGHT,
      color: hashColor(first.requestId, 65, 65),
      label: formatChainLabel(chain),
      detail: opBoxDetail(chain, respAnn, terminal),
      pending,
      linkedRailIdx,
      startAt: first.receivedAt,
      endAt: terminal?.receivedAt ?? response?.receivedAt ?? null,
    };
  }

  // Matched by suffix because terminators travel in both directions.
  const hasTerminator = sorted.some(
    e => e.tag.endsWith('_response') || e.tag.endsWith('_stop') || e.tag.endsWith('_interrupt'),
  );
  const last = sorted.at(-1) ?? first;
  const label = chain === null ? prettyTagLabel(first.tag) : formatChainLabel(chain);

  return {
    seqAnchor: first.seq,
    memberSeqs: sorted.map(e => e.seq),
    topY: seqToY.get(first.seq) ?? 0,
    bottomY: (seqToY.get(last.seq) ?? nowY) + ROW_HEIGHT,
    color: hashColor(first.requestId, 65, 65),
    label,
    detail: chain?.blockHash !== undefined ? `blk ${shortHex(chain.blockHash)}` : undefined,
    pending: !hasTerminator,
    startAt: first.receivedAt,
    endAt: hasTerminator ? last.receivedAt : null,
  };
}

/** A single-event flow becomes a one-row pill, so a point-in-time event still holds a lane at its Y. */
function systemSegmentForGroup(group: StoredSystemEvent[], seqToY: Map<EventSeq, number>): WorkingSegment {
  const sorted = [...group].sort((a, b) => a.seq - b.seq);
  const first = sorted[0];
  if (first === undefined) {
    throw new Error('systemSegmentForGroup: empty group');
  }
  const last = sorted.at(-1) ?? first;
  const pending = sorted.length > 1 && !sorted.some(e => isSystemFlowTerminator(e));
  const label = `${first.layer}.${first.event}`.replace(/_/g, '.');
  return {
    seqAnchor: first.seq,
    memberSeqs: sorted.map(e => e.seq),
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

function systemSegmentDetail(first: StoredSystemEvent, all: StoredSystemEvent[]): string | undefined {
  if (all.length === 1) {
    return undefined;
  }
  return `${first.layer}·${String(all.length)} step${all.length === 1 ? '' : 's'}`;
}

const SYSTEM_TERMINATOR_EVENTS: ReadonlySet<string> = new Set([
  'boot:ready',
  'boot:landing_page_shown',
  'bridge:first_outbound',
  'render:iframe_ready',
  'sandbox:document_written',
  'main:monitor_stopped',
]);

const SYSTEM_TERMINATOR_SUFFIXES: readonly string[] = [
  'failed',
  'completed',
  'terminated',
  'peer_action_processed',
  'peer_action_failed',
  'host_action_response_received',
  'host_action_failed',
  'resolve_completed',
  'resolve_failed',
];

export function isSystemFlowTerminator(ev: StoredSystemEvent): boolean {
  const event = ev.event;
  if (SYSTEM_TERMINATOR_EVENTS.has(`${ev.layer}:${event}`)) {
    return true;
  }
  return SYSTEM_TERMINATOR_SUFFIXES.some(suf => event === suf || event.endsWith(`_${suf}`));
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
  } else if (respChain?.outcome === 'limit-reached') {
    parts.push('limit-reached');
  } else if (respChain?.outcome === 'error') {
    parts.push(`err: ${respChain.errorMessage ?? '?'}`);
  }
  if (terminal !== undefined) {
    const tann = decodeChainAnnotations(terminal.tag, terminal.payload);
    if (tann?.chainEventTag !== undefined) {
      parts.push(`→ ${tann.chainEventTag}`);
    }
  }
  return parts.length === 0 ? undefined : parts.join(' · ');
}

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
  const match = /^follow_(\d+)$/.exec(syntheticId);
  if (match === null) {
    return undefined;
  }
  const ordinal = Number(match[1]);
  // The follow-start may have been evicted, so fall back to the last rail for this pair.
  const rail = rails[ordinal] ?? rails.at(-1);
  return rail?.railIdx;
}

function followKey(productId: string | undefined, genesisHash: string | undefined): string {
  return `${productId ?? '__anon'}|${genesisHash ?? '__unknown'}`;
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
  const prefix = genesisHash === undefined ? '(no chain)' : formatChainDisplay(genesisHash);
  return ordinal === 0 ? prefix : `${prefix} #${String(ordinal)}`;
}

function shortHex(v: string): string {
  if (v.startsWith('0x') && v.length > 8) {
    return `${v.slice(0, 6)}…`;
  }
  if (v.length > 8) {
    return `${v.slice(0, 6)}…`;
  }
  return v;
}

function prettyTagLabel(tag: string): string {
  // Dots let the narrow box label wrap across lines, matching the `chainHead.follow` style.
  return tag
    .replace(/^(remote_|host_)/, '')
    .replace(/_(request|response|start|receive|stop|submit|interrupt|subscribe)$/, '')
    .replace(/_/g, '.');
}
